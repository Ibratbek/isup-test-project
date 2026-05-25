'use strict';

const jwt    = require('jsonwebtoken');
const config = require('../config');

function authMiddleware(req, res, next) {
  if (config.auth.method === 'none') return next();

  if (config.auth.method === 'apikey') {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (!key || key !== config.auth.apiKey) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    return next();
  }

  // JWT
  const authHeader = req.headers.authorization || '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    req.user = jwt.verify(token, config.auth.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;
