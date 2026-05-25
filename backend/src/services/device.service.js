'use strict';

const { getDb }       = require('../db/database');
const { sendCommand } = require('./redis.service');
const logger          = require('../utils/logger');

function listDevices() {
  return getDb()
    .prepare('SELECT * FROM devices ORDER BY created_at DESC')
    .all();
}

function getDevice(id) {
  return getDb()
    .prepare('SELECT * FROM devices WHERE id = ? OR device_id = ?')
    .get(id, id);
}

function upsertDevice({ device_id, name, ip_address, model, status }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM devices WHERE device_id = ?').get(device_id);

  if (existing) {
    db.prepare(`
      UPDATE devices
      SET name = COALESCE(?, name),
          ip_address = COALESCE(?, ip_address),
          model = COALESCE(?, model),
          status = COALESCE(?, status),
          last_seen = CURRENT_TIMESTAMP
      WHERE device_id = ?
    `).run(name, ip_address, model, status, device_id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO devices (device_id, name, ip_address, model, status, last_seen)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(device_id, name || device_id, ip_address, model, status || 'offline');

  return result.lastInsertRowid;
}

function updateDeviceStatus(deviceId, status) {
  getDb().prepare(`
    UPDATE devices SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE device_id = ?
  `).run(status, deviceId);
}

async function openDoor(deviceId, doorIndex = 1) {
  const device = getDevice(deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  if (device.status !== 'online') throw new Error(`Device is offline: ${deviceId}`);

  return sendCommand('open_door', deviceId, { doorIndex });
}

async function rebootDevice(deviceId) {
  const device = getDevice(deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);

  return sendCommand('reboot_device', deviceId, {});
}

async function syncTime(deviceId) {
  const device = getDevice(deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);

  return sendCommand('sync_time', deviceId, {});
}

async function getDeviceInfo(deviceId) {
  const device = getDevice(deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);

  return sendCommand('get_device_info', deviceId, {});
}

module.exports = {
  listDevices,
  getDevice,
  upsertDevice,
  updateDeviceStatus,
  openDoor,
  rebootDevice,
  syncTime,
  getDeviceInfo,
};
