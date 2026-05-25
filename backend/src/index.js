'use strict';

const http = require('http');
const WebSocket = require('ws');
const express   = require('express');

const config        = require('./config');
const logger        = require('./utils/logger');
const { initDb, closeDb } = require('./db/database');
const { initRedis, closeRedis, onEvent } = require('./services/redis.service');
const { handleIncomingEvent } = require('./services/event.service');

const auth          = require('./middleware/auth');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const devicesRouter = require('./routes/devices.routes');
const usersRouter   = require('./routes/users.routes');
const eventsRouter  = require('./routes/events.routes');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();

app.use(express.json({ limit: '10mb' }));  // base64 images can be large
app.use(express.urlencoded({ extended: true }));

// Health check — no auth
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes — all protected
app.use('/api/devices', auth, devicesRouter);
app.use('/api/users',   auth, usersRouter);
app.use('/api/events',  auth, eventsRouter);

app.use(notFound);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws/events' });

// Track connected WS clients
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  // Simple API key check for WebSocket
  const url    = new URL(req.url, `http://${req.headers.host}`);
  const apiKey = url.searchParams.get('apiKey') || req.headers['x-api-key'];

  if (config.auth.method === 'apikey' && apiKey !== config.auth.apiKey) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  wsClients.add(ws);
  logger.info('WebSocket client connected', { total: wsClients.size });

  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info('WebSocket client disconnected', { total: wsClients.size });
  });

  ws.on('error', err => logger.error('WebSocket error', { err: err.message }));

  // Send a welcome message
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

function broadcastEvent(event) {
  const payload = JSON.stringify(event);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function start() {
  try {
    initDb();
    await initRedis();

    // Wire Redis events → DB persistence + WS broadcast
    onEvent(event => {
      handleIncomingEvent(event);
      broadcastEvent(event);
    });

    server.listen(config.port, () => {
      logger.info('Backend started', {
        port:    config.port,
        env:     config.nodeEnv,
        auth:    config.auth.method,
      });
    });

  } catch (err) {
    logger.error('Startup failed', { err: err.message });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);

  server.close(async () => {
    await closeRedis();
    closeDb();
    logger.info('Shutdown complete');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
