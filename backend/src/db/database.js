'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const config   = require('../config');
const logger   = require('../utils/logger');
const migrations = require('./migrations');

let db = null;

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function initDb() {
  const dbPath = path.resolve(config.db.path);
  const dir    = path.dirname(dbPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info('Database initialized', { path: dbPath });
  return db;
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map(r => r.version);

  for (const m of migrations) {
    if (!applied.includes(m.version)) {
      logger.info(`Applying migration v${m.version}`);
      const tx = database.transaction(() => {
        m.up(database);
        database
          .prepare('INSERT INTO schema_migrations (version) VALUES (?)')
          .run(m.version);
      });
      tx();
    }
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

module.exports = { initDb, getDb, closeDb };
