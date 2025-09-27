const AWSXRay = require('aws-xray-sdk-express');
const AWS = require('aws-sdk');
const { logger } = require('./logging');

// Configure X-Ray
if (process.env.NODE_ENV === 'production') {
  // Enable X-Ray tracing for AWS SDK
  const aws = AWSXRay.captureAWS(AWS);
  
  // Configure X-Ray daemon
  AWSXRay.config([
    AWSXRay.plugins.ECSPlugin,
    AWSXRay.plugins.EC2Plugin
  ]);

  // Set the daemon address if provided
  if (process.env.AWS_XRAY_DAEMON_ADDRESS) {
    AWSXRay.setDaemonAddress(process.env.AWS_XRAY_DAEMON_ADDRESS);
  }

  // Configure sampling
  AWSXRay.middleware.setSamplingRules({
    version: 2,
    default: {
      fixed_target: 1,
      rate: 0.1
    },
    rules: [
      {
        description: "MediaMint Backend",
        service_name: process.env.AWS_XRAY_TRACING_NAME || 'mediamint-backend',
        http_method: "*",
        url_path: "/api/*",
        fixed_target: 2,
        rate: 0.2
      },
      {
        description: "Health checks",
        service_name: process.env.AWS_XRAY_TRACING_NAME || 'mediamint-backend',
        http_method: "GET",
        url_path: "/health",
        fixed_target: 0,
        rate: 0.01
      }
    ]
  });

  logger.info('X-Ray tracing enabled', {
    daemonAddress: process.env.AWS_XRAY_DAEMON_ADDRESS,
    tracingName: process.env.AWS_XRAY_TRACING_NAME,
    contextMissing: process.env.AWS_XRAY_CONTEXT_MISSING
  });
} else {
  logger.info('X-Ray tracing disabled for development environment');
}

// Custom tracing utilities
const tracingUtils = {
  // Create a custom subsegment for database operations
  captureDatabase: (name, query, callback) => {
    if (process.env.NODE_ENV !== 'production') {
      return callback();
    }

    return AWSXRay.captureAsyncFunc(name, (subsegment) => {
      if (subsegment) {
        subsegment.addMetadata('query', query.replace(/\s+/g, ' ').trim());
        subsegment.addAnnotation('database', 'postgresql');
      }
      
      const startTime = Date.now();
      
      return callback().then(result => {
        if (subsegment) {
          const duration = Date.now() - startTime;
          subsegment.addMetadata('duration_ms', duration);
          subsegment.addMetadata('row_count', result?.rowCount || result?.rows?.length || 0);
          subsegment.close();
        }
        return result;
      }).catch(error => {
        if (subsegment) {
          subsegment.addError(error);
          subsegment.close(error);
        }
        throw error;
      });
    });
  },

  // Create a custom subsegment for AWS service calls
  captureAWS: (serviceName, operation, callback) => {
    if (process.env.NODE_ENV !== 'production') {
      return callback();
    }

    return AWSXRay.captureAsyncFunc(`${serviceName}.${operation}`, (subsegment) => {
      if (subsegment) {
        subsegment.addAnnotation('aws_service', serviceName);
        subsegment.addAnnotation('operation', operation);
      }
      
      const startTime = Date.now();
      
      return callback().then(result => {
        if (subsegment) {
          const duration = Date.now() - startTime;
          subsegment.addMetadata('duration_ms', duration);
          subsegment.addMetadata('result_size', JSON.stringify(result).length);
          subsegment.close();
        }
        return result;
      }).catch(error => {
        if (subsegment) {
          subsegment.addError(error);
          subsegment.addMetadata('error_code', error.code);
          subsegment.addMetadata('error_message', error.message);
          subsegment.close(error);
        }
        throw error;
      });
    });
  },

  // Add custom annotations and metadata to current segment
  addAnnotation: (key, value) => {
    if (process.env.NODE_ENV === 'production') {
      const segment = AWSXRay.getSegment();
      if (segment) {
        segment.addAnnotation(key, value);
      }
    }
  },

  addMetadata: (key, value, namespace = 'default') => {
    if (process.env.NODE_ENV === 'production') {
      const segment = AWSXRay.getSegment();
      if (segment) {
        segment.addMetadata(key, value, namespace);
      }
    }
  },

  // Get current trace ID for correlation
  getTraceId: () => {
    if (process.env.NODE_ENV === 'production') {
      const segment = AWSXRay.getSegment();
      return segment ? segment.trace_id : null;
    }
    return null;
  }
};

// Middleware for adding trace correlation to logs
const traceCorrelationMiddleware = (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    const segment = AWSXRay.getSegment();
    if (segment) {
      req.traceId = segment.trace_id;
      res.setHeader('X-Trace-Id', segment.trace_id);
    }
  }
  next();
};

// Enhanced error handling for X-Ray
const xrayErrorHandler = (error, req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    const segment = AWSXRay.getSegment();
    if (segment) {
      segment.addError(error);
      segment.addMetadata('error_details', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code
      }, 'error');
    }
  }
  next(error);
};

module.exports = {
  AWSXRay,
  tracingUtils,
  traceCorrelationMiddleware,
  xrayErrorHandler
};
