const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { Pool } = require('pg');
const { ECSClient, RunTaskCommand, StopTaskCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');
const { ElasticLoadBalancingV2Client, RegisterTargetsCommand, DeregisterTargetsCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');
const { EC2Client, DescribeNetworkInterfacesCommand } = require('@aws-sdk/client-ec2');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: [
    'https://frontend.vittas.in',
    'https://d3phvmll9t3ee2.cloudfront.net',
    'http://localhost:5173', // For local development
    'http://localhost:3000', // For local development
    'https://d3mdc4iuhybuoe.cloudfront.net' // Current CloudFront domain
  ],
  credentials: true
}));
app.use(express.json());

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

console.log('Database configuration:', {
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  ssl: dbConfig.ssl
});

// Validate hostname format
if (dbConfig.host && dbConfig.host.includes(':')) {
  console.error('ERROR: DB_HOST contains port number. It should be hostname only.');
  console.error('Current DB_HOST:', dbConfig.host);
  console.error('Expected format: hostname.region.rds.amazonaws.com');
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
  try {
    const secretArn = process.env.DB_PASSWORD_SECRET_ARN;
    if (!secretArn) {
      console.log('No DB_PASSWORD_SECRET_ARN provided, using environment variable');
      const envPassword = process.env.DB_PASSWORD;
      if (!envPassword) {
        throw new Error('No password found in environment variables');
      }
      return envPassword;
    }
    
    console.log('Retrieving database password from Secrets Manager...');
    console.log('Secret ARN:', secretArn);
    
    const command = new GetSecretValueCommand({
      SecretId: secretArn
    });
    
    const response = await secretsClient.send(command);
    
    if (!response.SecretString) {
      throw new Error('SecretString is empty in Secrets Manager response');
    }
    
    console.log('Secret retrieved, parsing JSON...');
    const secret = JSON.parse(response.SecretString);
    console.log('Secret keys:', Object.keys(secret));
    
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
      console.log(`Username from secret (${secretUsername}) differs from environment variable (${process.env.DB_USER})`);
      console.log('Using username from secret for consistency');
      // Store the correct username for later use
      process.env.DB_USER_FROM_SECRET = secretUsername;
    }
    
    console.log('Successfully retrieved database password from Secrets Manager');
    return password;
  } catch (error) {
    console.error('Error retrieving database password from Secrets Manager:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
      statusCode: error.$metadata?.httpStatusCode
    });
    
    console.log('Falling back to environment variable DB_PASSWORD');
    const envPassword = process.env.DB_PASSWORD;
    
    if (!envPassword) {
      throw new Error('No password available from Secrets Manager or environment variables');
    }
    
    if (typeof envPassword !== 'string') {
      throw new Error(`Environment password is not a string. Type: ${typeof envPassword}`);
    }
    
    return envPassword;
  }
};

// Initialize database connection
const initializeDatabase = async () => {
  try {
    console.log('Attempting to connect to database...');
    
    // Get the database password from Secrets Manager
    console.log('Retrieving database password...');
    const dbPassword = await getDbPassword();
    
    if (!dbPassword) {
      throw new Error('Database password is null or undefined');
    }
    
    if (typeof dbPassword !== 'string') {
      throw new Error(`Database password is not a string. Type: ${typeof dbPassword}`);
    }
    
    console.log('Password retrieved successfully, creating connection pool...');
    
    // Create database config with retrieved password and username from secret if available
    const dynamicDbConfig = {
      ...dbConfig,
      password: dbPassword,
      user: process.env.DB_USER_FROM_SECRET || dbConfig.user
    };
    
    // Log config without password for debugging
    console.log('Database configuration:', {
      host: dynamicDbConfig.host,
      port: dynamicDbConfig.port,
      database: dynamicDbConfig.database,
      user: dynamicDbConfig.user,
      ssl: dynamicDbConfig.ssl,
      passwordSet: !!dynamicDbConfig.password
    });
    
    pool = new Pool(dynamicDbConfig);
    
    // Test the connection with timeout
    console.log('Testing database connection...');
    const client = await pool.connect();
    console.log('Connected to PostgreSQL database successfully');
    
    // Test a simple query
    const result = await client.query('SELECT NOW()');
    console.log('Database query test successful:', result.rows[0]);
    
    client.release();
    
    return true;
  } catch (error) {
    console.error('Database connection error:', error.message);
    console.error('Error code:', error.code);
    console.error('Error details:', error);
    return false;
  }
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
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'mediamint-backend'
  });
});

// Trigger task endpoint - generates random string and queries database
app.post('/api/trigger-task', async (req, res) => {
  try {
    console.log('Task triggered at:', new Date().toISOString());
    
    // Generate random 88-character string
    const randomString = generateRandomString();
    console.log('Generated random string:', randomString);
    
    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    
    // Query database for list of databases
    let databases = [];
    if (pool) {
      try {
        console.log('Querying database for list of databases...');
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
        databases = result.rows;
        console.log('Successfully retrieved', databases.length, 'databases');
      } catch (dbError) {
        console.error('Error querying databases:', dbError);
        // Continue without databases if query fails
      }
    } else {
      console.warn('Database pool not available, returning empty database list');
    }
    
    // Log task completion
    console.log('Task completed successfully with random string:', randomString);
    
    res.json({
      success: true,
      message: 'Task completed successfully',
      randomString: randomString,
      databases: databases,
      databaseCount: databases.length,
      timestamp: new Date().toISOString(),
      processingTime: '~2 seconds'
    });
    
  } catch (error) {
    console.error('Error processing task:', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to process task',
      error: error.message,
      databases: []
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

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

// Start server
const startServer = async () => {
  // Initialize database connection
  const dbConnected = await initializeDatabase();
  
  if (!dbConnected) {
    console.warn('Starting server without database connection');
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
};

startServer().catch(console.error);
