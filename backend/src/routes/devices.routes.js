'use strict';

const express = require('express');
const router  = express.Router();

const deviceService = require('../services/device.service');

// GET /api/devices
router.get('/', (req, res, next) => {
  try {
    const devices = deviceService.listDevices();
    res.json({ data: devices, count: devices.length });
  } catch (err) { next(err); }
});

// GET /api/devices/:id
router.get('/:id', (req, res, next) => {
  try {
    const device = deviceService.getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json({ data: device });
  } catch (err) { next(err); }
});

// GET /api/devices/:id/status
router.get('/:id/status', (req, res, next) => {
  try {
    const device = deviceService.getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json({ deviceId: device.device_id, status: device.status, last_seen: device.last_seen });
  } catch (err) { next(err); }
});

// POST /api/devices/:id/open-door
router.post('/:id/open-door', async (req, res, next) => {
  try {
    const doorIndex = parseInt(req.body.doorIndex || req.body.door_index || '1', 10);
    const result = await deviceService.openDoor(req.params.id, doorIndex);
    res.json({ success: true, message: result.message });
  } catch (err) { next(err); }
});

// POST /api/devices/:id/reboot
router.post('/:id/reboot', async (req, res, next) => {
  try {
    const result = await deviceService.rebootDevice(req.params.id);
    res.json({ success: true, message: result.message });
  } catch (err) { next(err); }
});

// POST /api/devices/:id/sync-time
router.post('/:id/sync-time', async (req, res, next) => {
  try {
    const result = await deviceService.syncTime(req.params.id);
    res.json({ success: true, message: result.message });
  } catch (err) { next(err); }
});

// GET /api/devices/:id/info  (alias: get_device_info)
router.get('/:id/info', async (req, res, next) => {
  try {
    const result = await deviceService.getDeviceInfo(req.params.id);
    res.json({ success: true, data: result.data });
  } catch (err) { next(err); }
});

module.exports = router;
