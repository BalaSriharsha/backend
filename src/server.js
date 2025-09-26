const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { Pool } = require('pg');
const { ECSClient, RunTaskCommand, StopTaskCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');
const { ElasticLoadBalancingV2Client, RegisterTargetsCommand, DeregisterTargetsCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');
const { EC2Client, DescribeNetworkInterfacesCommand } = require('@aws-sdk/client-ec2');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
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

// ECS Configuration
const ECS_CLUSTER_NAME = process.env.ECS_CLUSTER_NAME || 'mediamint-prod';
const TASK_DEFINITION = process.env.ECS_TASK_DEFINITION_NAME || 'mediamint-prod';
const TARGET_GROUP_ARN = process.env.TARGET_GROUP_ARN;
const SUBNET_IDS = process.env.SUBNET_IDS ? process.env.SUBNET_IDS.split(',') : [];
const SECURITY_GROUP_ID = process.env.SECURITY_GROUP_ID;

// Initialize database connection
const initializeDatabase = async () => {
  try {
    console.log('Attempting to connect to database...');
    pool = new Pool(dbConfig);
    
    // Test the connection with timeout
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

// Trigger task endpoint
app.post('/api/trigger-task', async (req, res) => {
  let taskInfo = null;
  
  try {
    console.log('Task triggered at:', new Date().toISOString());
    
    // Generate random 88-character string
    const randomString = generateRandomString();
    console.log('Generated random string:', randomString);
    
    // Start ECS task
    taskInfo = await runECSTask();
    console.log('ECS task started successfully:', taskInfo.taskArn);
    
    // Simulate some work (in a real scenario, this would be the actual task processing)
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    
    res.json({
      success: true,
      message: 'Task triggered and completed successfully',
      randomString: randomString,
      taskArn: taskInfo.taskArn,
      taskIP: taskInfo.taskIP,
      timestamp: new Date().toISOString()
    });
    
    // Stop the task after responding (fire and forget)
    setTimeout(async () => {
      try {
        await stopECSTask(taskInfo.taskArn, taskInfo.taskIP);
        console.log('ECS task cleaned up successfully');
      } catch (cleanupError) {
        console.error('Error cleaning up ECS task:', cleanupError);
      }
    }, 2000); // Wait 2 seconds before cleanup
    
  } catch (error) {
    console.error('Error triggering task:', error);
    
    // Cleanup on error
    if (taskInfo) {
      try {
        await stopECSTask(taskInfo.taskArn, taskInfo.taskIP);
      } catch (cleanupError) {
        console.error('Error cleaning up failed task:', cleanupError);
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to trigger task',
      error: error.message
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
