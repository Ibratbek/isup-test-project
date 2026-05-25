'use strict';

const Redis  = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');

let publisher  = null;
let subscriber = null;

// Event listeners from other modules (WebSocket broadcast etc.)
const eventListeners = [];

function getPublisher() {
  if (!publisher) throw new Error('Redis not initialized');
  return publisher;
}

function onEvent(listener) {
  eventListeners.push(listener);
}

async function initRedis() {
  const opts = {
    host:           config.redis.host,
    port:           config.redis.port,
    lazyConnect:    true,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  };

  publisher  = new Redis(opts);
  subscriber = new Redis(opts);

  publisher.on('error',  err => logger.error('Redis pub error', { err: err.message }));
  subscriber.on('error', err => logger.error('Redis sub error', { err: err.message }));

  await publisher.connect();
  await subscriber.connect();

  // Subscribe to events from C++ bridge
  await subscriber.subscribe(config.redis_channels.events);

  subscriber.on('message', (channel, message) => {
    if (channel !== config.redis_channels.events) return;

    let event;
    try {
      event = JSON.parse(message);
    } catch {
      logger.warn('Redis: invalid JSON event', { message });
      return;
    }

    for (const listener of eventListeners) {
      try { listener(event); } catch (e) {
        logger.error('Event listener error', { err: e.message });
      }
    }
  });

  logger.info('Redis connected', { host: config.redis.host, port: config.redis.port });
}

/**
 * Send a command to the C++ bridge and wait for its response.
 * Returns a Promise that resolves/rejects within commandTimeoutMs.
 */
async function sendCommand(command, deviceId, params = {}) {
  const commandId = uuidv4();
  const payload   = JSON.stringify({ commandId, command, deviceId, params });

  const responseChannel = `${config.redis_channels.responses}:${commandId}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      tmpSub.unsubscribe(responseChannel).catch(() => {});
      tmpSub.quit().catch(() => {});
      reject(new Error(`Command timeout: ${command} on device ${deviceId}`));
    }, config.commandTimeoutMs);

    // One-shot subscriber for this command's response
    const tmpSub = new Redis({
      host: config.redis.host,
      port: config.redis.port,
    });

    tmpSub.subscribe(responseChannel, (err) => {
      if (err) {
        clearTimeout(timeout);
        tmpSub.quit().catch(() => {});
        return reject(err);
      }
    });

    tmpSub.on('message', (ch, msg) => {
      if (ch !== responseChannel) return;
      clearTimeout(timeout);
      tmpSub.unsubscribe(responseChannel).catch(() => {});
      tmpSub.quit().catch(() => {});

      try {
        const result = JSON.parse(msg);
        if (result.success) resolve(result);
        else reject(new Error(result.message || 'Command failed'));
      } catch {
        reject(new Error('Invalid response JSON'));
      }
    });

    // Publish after subscriber is ready (slight delay is fine for ioredis)
    getPublisher().publish(config.redis_channels.commands, payload)
      .catch(err => {
        clearTimeout(timeout);
        tmpSub.quit().catch(() => {});
        reject(err);
      });
  });
}

async function closeRedis() {
  if (subscriber) { await subscriber.quit(); subscriber = null; }
  if (publisher)  { await publisher.quit();  publisher  = null; }
  logger.info('Redis connections closed');
}

module.exports = { initRedis, closeRedis, sendCommand, onEvent, getPublisher };
