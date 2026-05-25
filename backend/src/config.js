'use strict';

require('dotenv').config();

module.exports = {
  port:      parseInt(process.env.PORT  || '3000', 10),
  nodeEnv:   process.env.NODE_ENV       || 'development',

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  db: {
    path: process.env.DB_PATH || './data/hikvision.db',
  },

  isup: {
    bridgePort: parseInt(process.env.ISUP_BRIDGE_PORT || '7660', 10),
  },

  storage: {
    uploadDir:    process.env.UPLOAD_DIR     || './data/uploads',
    faceImagesDir: process.env.FACE_IMAGES_DIR || './data/faces',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },

  auth: {
    method:    process.env.AUTH_METHOD || 'apikey',
    jwtSecret: process.env.JWT_SECRET  || 'change-me',
    apiKey:    process.env.API_KEY     || '',
  },

  commandTimeoutMs: parseInt(process.env.COMMAND_TIMEOUT_MS || '10000', 10),

  redis_channels: {
    events:    'hikvision:events',
    commands:  'hikvision:commands',
    responses: 'hikvision:responses',
  },
};
