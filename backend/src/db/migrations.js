'use strict';

const migrations = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id   TEXT UNIQUE NOT NULL,
          name        TEXT,
          ip_address  TEXT,
          model       TEXT,
          status      TEXT DEFAULT 'offline',
          last_seen   DATETIME,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS users (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id      TEXT UNIQUE NOT NULL,
          full_name        TEXT NOT NULL,
          face_image_path  TEXT,
          card_number      TEXT,
          phone            TEXT,
          department       TEXT,
          created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_device_sync (
          user_id    INTEGER NOT NULL,
          device_id  INTEGER NOT NULL,
          synced_at  DATETIME,
          status     TEXT DEFAULT 'pending',
          PRIMARY KEY (user_id, device_id),
          FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
          FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS events (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id        TEXT,
          user_id          TEXT,
          event_type       TEXT,
          event_data       TEXT,
          face_image_path  TEXT,
          timestamp        DATETIME,
          created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_events_device    ON events(device_id);
        CREATE INDEX IF NOT EXISTS idx_events_user      ON events(user_id);
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_type      ON events(event_type);
      `);
    },
  },
];

module.exports = migrations;
