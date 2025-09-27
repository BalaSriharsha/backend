const winston = require('winston');
const WinstonCloudWatch = require('winston-cloudwatch');
const correlationId = require('correlation-id');

// Custom format for structured logging
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const correlationIdValue = correlationId.getId();
    const logObject = {
      timestamp,
      level,
      message,
      correlationId: correlationIdValue,
      service: 'mediamint-backend',
      environment: process.env.NODE_ENV || 'development',
      ...meta
    };

    if (stack) {
      logObject.stack = stack;
    }

    return JSON.stringify(logObject);
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: {
    service: 'mediamint-backend',
    version: process.env.npm_package_version || '1.0.0'
  },
  transports: []
});

// Console transport for local development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// CloudWatch transport for production
if (process.env.NODE_ENV === 'production' && process.env.AWS_REGION) {
  logger.add(new WinstonCloudWatch({
    logGroupName: `/aws/application/${process.env.ECS_CLUSTER_NAME || 'mediamint-prod'}`,
    logStreamName: `backend-${new Date().toISOString().split('T')[0]}-${process.pid}`,
    awsRegion: process.env.AWS_REGION,
    messageFormatter: ({ level, message, additionalInfo }) => {
      return JSON.stringify({
        level,
        message,
        additionalInfo,
        timestamp: new Date().toISOString(),
        correlationId: correlationId.getId(),
        service: 'mediamint-backend'
      });
    },
    retentionInDays: 30,
    jsonMessage: true
  }));
}

// Performance monitoring helper
const performanceLogger = {
  startTimer: (label) => {
    const start = Date.now();
    return {
      end: (additionalInfo = {}) => {
        const duration = Date.now() - start;
        logger.info('Performance metric', {
          metric: label,
          duration: `${duration}ms`,
          ...additionalInfo
        });
        return duration;
      }
    };
  },

  logDatabaseQuery: (query, duration, rowCount = null) => {
    logger.info('Database query executed', {
      query: query.replace(/\s+/g, ' ').trim(),
      duration: `${duration}ms`,
      rowCount,
      type: 'database_query'
    });
  },

  logAPICall: (method, url, statusCode, duration, userId = null) => {
    logger.info('API call completed', {
      method,
      url,
      statusCode,
      duration: `${duration}ms`,
      userId,
      type: 'api_call'
    });
  }
};

// Error logging helpers
const errorLogger = {
  logError: (error, context = {}) => {
    logger.error('Application error', {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code
      },
      context,
      type: 'application_error'
    });
  },

  logDatabaseError: (error, query = null) => {
    logger.error('Database error', {
      error: {
        name: error.name,
        message: error.message,
        code: error.code,
        detail: error.detail,
        hint: error.hint
      },
      query: query ? query.replace(/\s+/g, ' ').trim() : null,
      type: 'database_error'
    });
  },

  logAWSError: (error, service, operation) => {
    logger.error('AWS service error', {
      error: {
        name: error.name,
        message: error.message,
        code: error.code,
        statusCode: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId
      },
      service,
      operation,
      type: 'aws_error'
    });
  }
};

// Business logic logging
const businessLogger = {
  logTaskExecution: (taskId, status, duration = null, details = {}) => {
    logger.info('Task execution', {
      taskId,
      status,
      duration: duration ? `${duration}ms` : null,
      details,
      type: 'task_execution'
    });
  },

  logUserAction: (action, userId = null, details = {}) => {
    logger.info('User action', {
      action,
      userId,
      details,
      type: 'user_action'
    });
  },

  logSecurityEvent: (event, severity = 'medium', details = {}) => {
    logger.warn('Security event', {
      event,
      severity,
      details,
      type: 'security_event'
    });
  }
};

module.exports = {
  logger,
  performanceLogger,
  errorLogger,
  businessLogger
};
