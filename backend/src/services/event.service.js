'use strict';

const { getDb }                         = require('../db/database');
const { updateDeviceStatus, upsertDevice } = require('./device.service');
const logger                            = require('../utils/logger');

/**
 * Called by redis.service when a new event arrives from the C++ bridge.
 * Persists to SQLite and triggers any registered WebSocket broadcasts.
 */
function handleIncomingEvent(event) {
  const { type, deviceId, timestamp } = event;

  try {
    switch (type) {
      case 'device_online':
        upsertDevice({
          device_id:  deviceId,
          ip_address: event.ip   || null,
          model:      event.model || null,
          status:     'online',
        });
        break;
      case 'device_offline':
        updateDeviceStatus(deviceId, 'offline');
        break;
      default:
        persistEvent(event);
        break;
    }
  } catch (err) {
    logger.error('Event handling error', { err: err.message, event });
  }
}

function persistEvent(event) {
  const { type, deviceId, timestamp } = event;
  const userId = event.employeeId || event.userId || null;

  // Extract face image if present (save separately)
  let faceImagePath = null;
  if (event.faceImage) {
    faceImagePath = saveFaceSnapshot(deviceId, userId, event.faceImage);
    delete event.faceImage; // don't store base64 in DB
  }

  getDb().prepare(`
    INSERT INTO events (device_id, user_id, event_type, event_data, face_image_path, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    deviceId,
    userId,
    type,
    JSON.stringify(event),
    faceImagePath,
    timestamp || new Date().toISOString(),
  );
}

function listEvents({ deviceId, userId, type, dateFrom, dateTo, page = 1, limit = 50 } = {}) {
  let sql    = 'SELECT * FROM events WHERE 1=1';
  const args = [];

  if (deviceId) { sql += ' AND device_id = ?';    args.push(deviceId); }
  if (userId)   { sql += ' AND user_id = ?';       args.push(userId); }
  if (type)     { sql += ' AND event_type = ?';    args.push(type); }
  if (dateFrom) { sql += ' AND timestamp >= ?';    args.push(dateFrom); }
  if (dateTo)   { sql += ' AND timestamp <= ?';    args.push(dateTo); }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  args.push(limit, (page - 1) * limit);

  return getDb().prepare(sql).all(...args);
}

/**
 * Returns attendance-like report: first entry & last entry per user per day.
 */
function attendanceReport({ dateFrom, dateTo, department } = {}) {
  let sql = `
    SELECT
      e.user_id,
      u.full_name,
      u.department,
      date(e.timestamp) AS work_date,
      MIN(e.timestamp)  AS first_entry,
      MAX(e.timestamp)  AS last_exit,
      COUNT(*)          AS event_count
    FROM events e
    LEFT JOIN users u ON u.employee_id = e.user_id
    WHERE e.event_type IN ('face_recognition', 'access_control')
      AND e.user_id IS NOT NULL
  `;
  const args = [];

  if (dateFrom) { sql += ' AND date(e.timestamp) >= ?'; args.push(dateFrom); }
  if (dateTo)   { sql += ' AND date(e.timestamp) <= ?'; args.push(dateTo); }
  if (department) { sql += ' AND u.department = ?'; args.push(department); }

  sql += ' GROUP BY e.user_id, work_date ORDER BY work_date DESC, u.full_name';

  return getDb().prepare(sql).all(...args);
}

function saveFaceSnapshot(deviceId, userId, base64Data) {
  const fs   = require('fs');
  const path = require('path');
  const cfg  = require('../config');

  const dir = path.resolve(cfg.storage.faceImagesDir, 'snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts       = Date.now();
  const filename = `${deviceId}_${userId || 'unknown'}_${ts}.jpg`;
  const filePath = path.join(dir, filename);

  const raw = base64Data.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(raw, 'base64'));

  return filePath;
}

module.exports = { handleIncomingEvent, listEvents, attendanceReport };
