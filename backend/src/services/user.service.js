'use strict';

const fs   = require('fs');
const path = require('path');

const { getDb }       = require('../db/database');
const { sendCommand } = require('./redis.service');
const config          = require('../config');
const logger          = require('../utils/logger');

function listUsers(filters = {}) {
  let sql    = 'SELECT * FROM users';
  const args = [];

  if (filters.department) {
    sql += ' WHERE department = ?';
    args.push(filters.department);
  }

  sql += ' ORDER BY full_name';
  return getDb().prepare(sql).all(...args);
}

function getUser(id) {
  return getDb()
    .prepare('SELECT * FROM users WHERE id = ? OR employee_id = ?')
    .get(id, id);
}

function createUser({ employee_id, full_name, card_number, phone, department, faceImageBase64 }) {
  const db = getDb();

  if (db.prepare('SELECT id FROM users WHERE employee_id = ?').get(employee_id)) {
    throw new Error(`Employee ID already exists: ${employee_id}`);
  }

  let face_image_path = null;
  if (faceImageBase64) {
    face_image_path = saveFaceImage(employee_id, faceImageBase64);
  }

  const result = db.prepare(`
    INSERT INTO users (employee_id, full_name, face_image_path, card_number, phone, department)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(employee_id, full_name, face_image_path, card_number, phone, department);

  return result.lastInsertRowid;
}

function updateUser(id, fields) {
  const db   = getDb();
  const user = getUser(id);
  if (!user) throw new Error(`User not found: ${id}`);

  if (fields.faceImageBase64) {
    fields.face_image_path = saveFaceImage(user.employee_id, fields.faceImageBase64);
    delete fields.faceImageBase64;
  }

  const allowed = ['full_name', 'card_number', 'phone', 'department', 'face_image_path'];
  const updates = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([k]) => `${k} = ?`);

  if (updates.length === 0) return;

  const values = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([, v]) => v);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values, user.id);
}

function deleteUser(id) {
  const user = getUser(id);
  if (!user) throw new Error(`User not found: ${id}`);

  getDb().prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return user;
}

async function syncUserToDevice(userId, deviceId) {
  const db     = getDb();
  const user   = getUser(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR device_id = ?')
    .get(deviceId, deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);

  let faceImageBase64 = null;
  if (user.face_image_path && fs.existsSync(user.face_image_path)) {
    const buf = fs.readFileSync(user.face_image_path);
    faceImageBase64 = buf.toString('base64');
  }

  const params = {
    employeeId: user.employee_id,
    name:       user.full_name,
    cardNo:     user.card_number || user.employee_id,
    faceImage:  faceImageBase64,
  };

  try {
    await sendCommand('add_user', device.device_id, params);

    if (faceImageBase64) {
      await sendCommand('upload_face', device.device_id, {
        employeeId: user.employee_id,
        cardNo:     params.cardNo,
        faceImage:  faceImageBase64,
      });
    }

    db.prepare(`
      INSERT INTO user_device_sync (user_id, device_id, synced_at, status)
      VALUES (?, ?, CURRENT_TIMESTAMP, 'synced')
      ON CONFLICT(user_id, device_id)
      DO UPDATE SET synced_at = CURRENT_TIMESTAMP, status = 'synced'
    `).run(user.id, device.id);

    logger.info('User synced to device', { userId, deviceId });
    return { success: true };

  } catch (err) {
    db.prepare(`
      INSERT INTO user_device_sync (user_id, device_id, synced_at, status)
      VALUES (?, ?, CURRENT_TIMESTAMP, 'failed')
      ON CONFLICT(user_id, device_id)
      DO UPDATE SET synced_at = CURRENT_TIMESTAMP, status = 'failed'
    `).run(user.id, device.id);

    throw err;
  }
}

async function bulkSync(userId) {
  const devices = getDb().prepare("SELECT * FROM devices WHERE status = 'online'").all();

  const results = await Promise.allSettled(
    devices.map(d => syncUserToDevice(userId, d.device_id))
  );

  return devices.map((d, i) => ({
    deviceId: d.device_id,
    success:  results[i].status === 'fulfilled',
    error:    results[i].reason?.message,
  }));
}

function saveFaceImage(employeeId, base64Data) {
  const dir = path.resolve(config.storage.faceImagesDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const raw      = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buf      = Buffer.from(raw, 'base64');
  const filePath = path.join(dir, `${employeeId}.jpg`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  syncUserToDevice,
  bulkSync,
};
