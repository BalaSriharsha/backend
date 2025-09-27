// X-Ray must be imported first for proper instrumentation
const { AWSXRay, tracingUtils, traceCorrelationMiddleware, xrayErrorHandler } = require('./config/tracing');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const correlationId = require('correlation-id');
const { v4: uuidv4 } = require('uuid');

// Import logging configuration
const { logger, performanceLogger, errorLogger, businessLogger } = require('./config/logging');

// AWS SDK imports with X-Ray tracing
const { Pool } = require('pg');
const { ECSClient, RunTaskCommand, StopTaskCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');
const { ElasticLoadBalancingV2Client, RegisterTargetsCommand, DeregisterTargetsCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');
const { EC2Client, DescribeNetworkInterfacesCommand } = require('@aws-sdk/client-ec2');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// X-Ray tracing middleware (must be first)
if (process.env.NODE_ENV === 'production') {
  app.use(AWSXRay.express.openSegment(process.env.AWS_XRAY_TRACING_NAME || 'mediamint-backend'));
}

// Correlation ID middleware
app.use((req, res, next) => {
  const correlationIdValue = req.headers['x-correlation-id'] || uuidv4();
  correlationId.withId(correlationIdValue, () => {
    req.correlationId = correlationIdValue;
    res.setHeader('X-Correlation-ID', correlationIdValue);
    
    // Add to X-Ray trace
    tracingUtils.addAnnotation('correlationId', correlationIdValue);
    
    next();
  });
});

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  logger.info('Request started', {
    method: req.method,
    url: req.url,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    correlationId: req.correlationId,
    traceId: tracingUtils.getTraceId()
  });

  // Override res.end to log response
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    
    performanceLogger.logAPICall(
      req.method,
      req.url,
      res.statusCode,
      duration
    );

    // Add response metadata to X-Ray
    tracingUtils.addMetadata('response', {
      statusCode: res.statusCode,
      duration: duration
    });

    originalEnd.apply(this, args);
  };

  next();
});

// Standard middleware
app.use(helmet());
app.use(cors({
  origin: [
    'https://frontend.vittas.in',
    'https://d3phvmll9t3ee2.cloudfront.net',
    'http://localhost:5173', // For local development
    'http://localhost:3000'  // For local development
  ],
  credentials: true
}));
app.use(express.json());

// Trace correlation middleware
app.use(traceCorrelationMiddleware);

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

logger.info('Database configuration initialized', {
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  ssl: !!dbConfig.ssl,
  maxConnections: dbConfig.max
});

// Validate hostname format
if (dbConfig.host && dbConfig.host.includes(':')) {
  errorLogger.logError(new Error('Invalid DB_HOST configuration'), {
    currentHost: dbConfig.host,
    expectedFormat: 'hostname.region.rds.amazonaws.com',
    issue: 'DB_HOST contains port number'
  });
}

let pool;

// Initialize AWS clients
const ecsClient = new ECSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const elbClient = new ElasticLoadBalancingV2Client({ region: process.env.AWS_REGION || 'us-east-1' });
const ec2Client = new EC2Client({ region: process.env.AWS_REGION || 'us-east-1' });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

// ECS Configuration
const ECS_CLUSTER_NAME = process.env.ECS_CLUSTER_NAME || 'mediamint-prod';
const TASK_DEFINITION = process.env.ECS_TASK_DEFINITION_NAME || 'mediamint-prod';
const TARGET_GROUP_ARN = process.env.TARGET_GROUP_ARN;
const SUBNET_IDS = process.env.SUBNET_IDS ? process.env.SUBNET_IDS.split(',') : [];
const SECURITY_GROUP_ID = process.env.SECURITY_GROUP_ID;

// Function to retrieve database password from Secrets Manager
const getDbPassword = async () => {
  const timer = performanceLogger.startTimer('getDbPassword');
  
  return tracingUtils.captureAWS('SecretsManager', 'GetSecretValue', async () => {
    try {
      const secretArn = process.env.DB_PASSWORD_SECRET_ARN;
      if (!secretArn) {
        logger.info('No DB_PASSWORD_SECRET_ARN provided, using environment variable');
        const envPassword = process.env.DB_PASSWORD;
        if (!envPassword) {
          throw new Error('No password found in environment variables');
        }
        timer.end({ source: 'environment' });
        return envPassword;
      }
      
      logger.info('Retrieving database password from Secrets Manager', {
        secretArn: secretArn.split(':').slice(-1)[0] // Log only the secret name, not full ARN
      });
      
      const command = new GetSecretValueCommand({
        SecretId: secretArn
      });
      
      const response = await secretsClient.send(command);
      
      if (!response.SecretString) {
        throw new Error('SecretString is empty in Secrets Manager response');
      }
      
      logger.debug('Secret retrieved, parsing JSON');
      const secret = JSON.parse(response.SecretString);
      
      // Try different possible password field names
      const password = secret.password || secret.Password || secret.PGPASSWORD;
      
      if (!password) {
        throw new Error('No password field found in secret. Available fields: ' + Object.keys(secret).join(', '));
      }
      
      if (typeof password !== 'string') {
        throw new Error(`Password is not a string. Type: ${typeof password}, Value: ${password}`);
      }
      
      // Also check if we need to update the username from the secret
      const secretUsername = secret.username || secret.Username;
      if (secretUsername && secretUsername !== process.env.DB_USER) {
        logger.info('Username from secret differs from environment variable', {
          secretUsername,
          envUsername: process.env.DB_USER
        });
        // Store the correct username for later use
        process.env.DB_USER_FROM_SECRET = secretUsername;
      }
      
      logger.info('Successfully retrieved database password from Secrets Manager');
      timer.end({ source: 'secrets_manager' });
      return password;
    } catch (error) {
      errorLogger.logAWSError(error, 'SecretsManager', 'GetSecretValue');
      
      logger.warn('Falling back to environment variable DB_PASSWORD');
      const envPassword = process.env.DB_PASSWORD;
      
      if (!envPassword) {
        timer.end({ source: 'error', error: 'No password available' });
        throw new Error('No password available from Secrets Manager or environment variables');
      }
      
      if (typeof envPassword !== 'string') {
        timer.end({ source: 'error', error: 'Invalid password type' });
        throw new Error(`Environment password is not a string. Type: ${typeof envPassword}`);
      }
      
      timer.end({ source: 'environment_fallback' });
      return envPassword;
    }
  });
};

// Initialize database connection
const initializeDatabase = async () => {
  const timer = performanceLogger.startTimer('initializeDatabase');
  
  return tracingUtils.captureDatabase('database_initialization', 'SELECT NOW()', async () => {
    try {
      logger.info('Attempting to connect to database');
      
      // Get the database password from Secrets Manager
      logger.debug('Retrieving database password');
      const dbPassword = await getDbPassword();
      
      if (!dbPassword) {
        throw new Error('Database password is null or undefined');
      }
      
      if (typeof dbPassword !== 'string') {
        throw new Error(`Database password is not a string. Type: ${typeof dbPassword}`);
      }
      
      logger.info('Password retrieved successfully, creating connection pool');
      
      // Create database config with retrieved password and username from secret if available
      const dynamicDbConfig = {
        ...dbConfig,
        password: dbPassword,
        user: process.env.DB_USER_FROM_SECRET || dbConfig.user
      };
      
      // Log config without password for debugging
      logger.info('Final database configuration', {
        host: dynamicDbConfig.host,
        port: dynamicDbConfig.port,
        database: dynamicDbConfig.database,
        user: dynamicDbConfig.user,
        ssl: !!dynamicDbConfig.ssl,
        maxConnections: dynamicDbConfig.max,
        passwordSet: !!dynamicDbConfig.password
      });
      
      pool = new Pool(dynamicDbConfig);
      
      // Add pool event listeners for monitoring
      pool.on('connect', (client) => {
        logger.debug('New database client connected');
      });
      
      pool.on('error', (error) => {
        errorLogger.logDatabaseError(error);
      });
      
      // Test the connection with timeout
      logger.info('Testing database connection');
      const client = await pool.connect();
      logger.info('Connected to PostgreSQL database successfully');
      
      // Test a simple query
      const queryStart = Date.now();
      const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
      const queryDuration = Date.now() - queryStart;
      
      performanceLogger.logDatabaseQuery('SELECT NOW(), version()', queryDuration, 1);
      
      logger.info('Database query test successful', {
        currentTime: result.rows[0].current_time,
        postgresVersion: result.rows[0].pg_version.split(' ')[0],
        queryDuration: `${queryDuration}ms`
      });
      
      client.release();
      
      timer.end({ status: 'success' });
      return true;
    } catch (error) {
      errorLogger.logDatabaseError(error, 'Database initialization failed');
      timer.end({ status: 'error', error: error.message });
      return false;
    }
  });
};

// Generate random 88-character string
const generateRandomString = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 88; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Run ECS task and register with target group
const runECSTask = async () => {
  try {
    console.log('Starting ECS task...');
    
    const runTaskParams = {
      cluster: ECS_CLUSTER_NAME,
      taskDefinition: TASK_DEFINITION,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNET_IDS,
          securityGroups: [SECURITY_GROUP_ID],
          assignPublicIp: 'DISABLED'
        }
      },
      count: 1
    };

    const runTaskResponse = await ecsClient.send(new RunTaskCommand(runTaskParams));
    
    if (!runTaskResponse.tasks || runTaskResponse.tasks.length === 0) {
      throw new Error('Failed to start ECS task');
    }

    const task = runTaskResponse.tasks[0];
    const taskArn = task.taskArn;
    
    console.log('ECS task started:', taskArn);

    // Wait for task to be running and get its IP
    let taskIP = null;
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes max wait

    while (!taskIP && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
      attempts++;

      try {
        const describeParams = {
          cluster: ECS_CLUSTER_NAME,
          tasks: [taskArn]
        };

        const describeResponse = await ecsClient.send(new DescribeTasksCommand(describeParams));
        
        if (describeResponse.tasks && describeResponse.tasks.length > 0) {
          const task = describeResponse.tasks[0];
          
          if (task.lastStatus === 'RUNNING') {
            // Get the network interface to find the IP
            const networkInterface = task.attachments?.[0]?.details?.find(
              detail => detail.name === 'networkInterfaceId'
            );
            
            if (networkInterface) {
              const eniParams = {
                NetworkInterfaceIds: [networkInterface.value]
              };
              
              const eniResponse = await ec2Client.send(new DescribeNetworkInterfacesCommand(eniParams));
              
              if (eniResponse.NetworkInterfaces && eniResponse.NetworkInterfaces.length > 0) {
                taskIP = eniResponse.NetworkInterfaces[0].PrivateIpAddress;
                console.log('Task IP found:', taskIP);
              }
            }
          } else if (task.lastStatus === 'STOPPED') {
            throw new Error('Task stopped before becoming ready');
          }
        }
      } catch (error) {
        console.warn('Error checking task status:', error.message);
      }
    }

    if (!taskIP) {
      throw new Error('Could not determine task IP address');
    }

    // Register task with target group
    if (TARGET_GROUP_ARN) {
      const registerParams = {
        TargetGroupArn: TARGET_GROUP_ARN,
        Targets: [
          {
            Id: taskIP,
            Port: 3000
          }
        ]
      };

      await elbClient.send(new RegisterTargetsCommand(registerParams));
      console.log('Task registered with target group');

      // Wait a bit for health checks to pass
      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
    }

    return { taskArn, taskIP };
  } catch (error) {
    console.error('Error running ECS task:', error);
    throw error;
  }
};

// Stop ECS task and deregister from target group
const stopECSTask = async (taskArn, taskIP) => {
  try {
    console.log('Stopping ECS task:', taskArn);

    // Deregister from target group first
    if (TARGET_GROUP_ARN && taskIP) {
      const deregisterParams = {
        TargetGroupArn: TARGET_GROUP_ARN,
        Targets: [
          {
            Id: taskIP,
            Port: 3000
          }
        ]
      };

      await elbClient.send(new DeregisterTargetsCommand(deregisterParams));
      console.log('Task deregistered from target group');
    }

    // Stop the task
    const stopParams = {
      cluster: ECS_CLUSTER_NAME,
      task: taskArn,
      reason: 'Task completed successfully'
    };

    await ecsClient.send(new StopTaskCommand(stopParams));
    console.log('ECS task stopped');
  } catch (error) {
    console.error('Error stopping ECS task:', error);
    throw error;
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  const healthData = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'mediamint-backend',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    database: pool ? 'connected' : 'disconnected',
    correlationId: req.correlationId,
    traceId: tracingUtils.getTraceId()
  };

  // Add health check annotation to X-Ray
  tracingUtils.addAnnotation('endpoint', 'health');
  tracingUtils.addMetadata('health_status', healthData);

  logger.debug('Health check requested', healthData);
  res.json(healthData);
});

// Trigger task endpoint - generates random string and queries database
app.post('/api/trigger-task', async (req, res) => {
  const taskId = uuidv4();
  const timer = performanceLogger.startTimer('trigger-task');
  
  try {
    logger.info('Task triggered', { taskId, timestamp: new Date().toISOString() });
    businessLogger.logTaskExecution(taskId, 'started');
    
    // Add task annotations to X-Ray
    tracingUtils.addAnnotation('endpoint', 'trigger-task');
    tracingUtils.addAnnotation('taskId', taskId);
    
    // Generate random 88-character string
    const randomString = generateRandomString();
    logger.info('Generated random string', { 
      taskId, 
      randomStringLength: randomString.length,
      randomStringPreview: randomString.substring(0, 10) + '...'
    });
    
    // Simulate some processing time
    logger.debug('Starting processing delay', { taskId });
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    
    // Query database for list of databases
    let databases = [];
    if (pool) {
      try {
        logger.info('Querying database for list of databases', { taskId });
        const query = `
          SELECT 
            datname as name,
            pg_size_pretty(pg_database_size(datname)) as size
          FROM pg_database 
          WHERE datistemplate = false 
            AND datname != 'rdsadmin'
          ORDER BY datname;
        `;
        
        const queryStart = Date.now();
        const result = await tracingUtils.captureDatabase('get_databases', query, async () => {
          return await pool.query(query);
        });
        const queryDuration = Date.now() - queryStart;
        
        databases = result.rows;
        performanceLogger.logDatabaseQuery(query, queryDuration, databases.length);
        
        logger.info('Successfully retrieved databases', { 
          taskId, 
          databaseCount: databases.length,
          queryDuration: `${queryDuration}ms`
        });
        
        // Add database info to X-Ray
        tracingUtils.addMetadata('database_query', {
          query: 'get_databases',
          count: databases.length,
          duration: queryDuration
        });
        
      } catch (dbError) {
        errorLogger.logDatabaseError(dbError, 'Error querying databases');
        logger.warn('Database query failed, continuing without databases', { 
          taskId, 
          error: dbError.message 
        });
        // Continue without databases if query fails
      }
    } else {
      logger.warn('Database pool not available, returning empty database list', { taskId });
    }
    
    const totalDuration = timer.end({ status: 'success', databaseCount: databases.length });
    businessLogger.logTaskExecution(taskId, 'completed', totalDuration, {
      randomStringGenerated: true,
      databasesRetrieved: databases.length,
      processingTimeMs: totalDuration
    });
    
    const responseData = {
      success: true,
      message: 'Task completed successfully',
      taskId: taskId,
      randomString: randomString,
      databases: databases,
      databaseCount: databases.length,
      timestamp: new Date().toISOString(),
      processingTime: `${totalDuration}ms`,
      correlationId: req.correlationId,
      traceId: tracingUtils.getTraceId()
    };
    
    // Add response metadata to X-Ray
    tracingUtils.addMetadata('response', responseData);
    
    logger.info('Task completed successfully', { 
      taskId, 
      databaseCount: databases.length,
      totalDuration: `${totalDuration}ms`
    });
    
    res.json(responseData);
    
  } catch (error) {
    const duration = timer.end({ status: 'error', error: error.message });
    errorLogger.logError(error, { taskId, endpoint: 'trigger-task' });
    businessLogger.logTaskExecution(taskId, 'failed', duration, { error: error.message });
    
    // Add error to X-Ray
    tracingUtils.addMetadata('error', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    
    logger.error('Task processing failed', { 
      taskId, 
      error: error.message,
      duration: `${duration}ms`
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to process task',
      taskId: taskId,
      error: error.message,
      databases: [],
      correlationId: req.correlationId,
      traceId: tracingUtils.getTraceId()
    });
  }
});

// Get list of databases endpoint
app.get('/api/databases', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        success: false,
        message: 'Database connection not available',
        databases: []
      });
    }

    // Query to get list of databases
    const query = `
      SELECT 
        datname as name,
        pg_size_pretty(pg_database_size(datname)) as size
      FROM pg_database 
      WHERE datistemplate = false 
        AND datname != 'rdsadmin'
      ORDER BY datname;
    `;
    
    const result = await pool.query(query);
    
    res.json({
      success: true,
      databases: result.rows,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('Error fetching databases:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch databases',
      error: error.message,
      databases: []
    });
  }
});

// Get database connection info (for debugging)
app.get('/api/db-info', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const versionQuery = 'SELECT version();';
    const result = await pool.query(versionQuery);
    
    res.json({
      success: true,
      version: result.rows[0].version,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME || 'postgres'
    });
    
  } catch (error) {
    console.error('Error fetching database info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch database info',
      error: error.message
    });
  }
});

// X-Ray error handling middleware (must come before other error handlers)
app.use(xrayErrorHandler);

// Error handling middleware
app.use((error, req, res, next) => {
  errorLogger.logError(error, {
    method: req.method,
    url: req.url,
    correlationId: req.correlationId,
    userAgent: req.headers['user-agent'],
    ip: req.ip
  });

  // Add error to business logger for monitoring
  businessLogger.logSecurityEvent('unhandled_error', 'high', {
    error: error.message,
    endpoint: req.url,
    method: req.method
  });

  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    correlationId: req.correlationId,
    traceId: tracingUtils.getTraceId()
  });
});

// 404 handler
app.use('*', (req, res) => {
  logger.warn('Route not found', {
    method: req.method,
    url: req.url,
    correlationId: req.correlationId,
    userAgent: req.headers['user-agent'],
    ip: req.ip
  });

  // Log as potential security event
  businessLogger.logSecurityEvent('route_not_found', 'low', {
    method: req.method,
    url: req.url,
    ip: req.ip
  });

  tracingUtils.addAnnotation('error', '404_not_found');
  tracingUtils.addMetadata('not_found', {
    method: req.method,
    url: req.url
  });

  res.status(404).json({
    success: false,
    message: 'Route not found',
    correlationId: req.correlationId,
    traceId: tracingUtils.getTraceId()
  });
});

// Close X-Ray segment (must be last middleware in production)
if (process.env.NODE_ENV === 'production') {
  app.use(AWSXRay.express.closeSegment());
}

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, starting graceful shutdown`);
  
  try {
    // Close database connections
    if (pool) {
      logger.info('Closing database connection pool');
      await pool.end();
      logger.info('Database connection pool closed');
    }
    
    // Flush any pending logs
    logger.info('Flushing pending logs');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    errorLogger.logError(error, { context: 'graceful_shutdown', signal });
    logger.error('Error during graceful shutdown', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  errorLogger.logError(error, { context: 'uncaught_exception' });
  logger.fatal('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  errorLogger.logError(new Error('Unhandled Rejection'), { 
    context: 'unhandled_rejection',
    reason: reason?.toString(),
    promise: promise?.toString()
  });
  logger.fatal('Unhandled promise rejection', { reason });
  process.exit(1);
});

// Start server
const startServer = async () => {
  const startupTimer = performanceLogger.startTimer('server_startup');
  
  try {
    logger.info('Starting MediaMint backend server', {
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      port: PORT,
      region: process.env.AWS_REGION,
      xrayEnabled: process.env.NODE_ENV === 'production'
    });
    
    // Initialize database connection
    logger.info('Initializing database connection');
    const dbConnected = await initializeDatabase();
    
    if (!dbConnected) {
      logger.warn('Starting server without database connection');
      businessLogger.logSecurityEvent('database_unavailable', 'high', {
        message: 'Server started without database connection'
      });
    } else {
      logger.info('Database connection established successfully');
    }
    
    // Start the HTTP server
    const server = app.listen(PORT, '0.0.0.0', () => {
      const startupDuration = startupTimer.end({ 
        status: 'success', 
        databaseConnected: dbConnected 
      });
      
      logger.info('Server started successfully', {
        port: PORT,
        host: '0.0.0.0',
        startupTime: `${startupDuration}ms`,
        healthCheck: `http://localhost:${PORT}/health`,
        environment: process.env.NODE_ENV || 'development',
        databaseConnected: dbConnected
      });
      
      // Log startup completion
      businessLogger.logUserAction('server_startup', null, {
        port: PORT,
        startupTime: startupDuration,
        databaseConnected: dbConnected
      });
    });

    // Handle server errors
    server.on('error', (error) => {
      errorLogger.logError(error, { context: 'server_error' });
      logger.fatal('Server error', { error: error.message });
    });

    // Handle server close
    server.on('close', () => {
      logger.info('HTTP server closed');
    });
    
  } catch (error) {
    const startupDuration = startupTimer.end({ 
      status: 'error', 
      error: error.message 
    });
    
    errorLogger.logError(error, { context: 'server_startup' });
    logger.fatal('Failed to start server', { 
      error: error.message,
      startupTime: `${startupDuration}ms`
    });
    
    process.exit(1);
  }
};

// Start the server
startServer();
