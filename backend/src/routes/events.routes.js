'use strict';

const express = require('express');
const router  = express.Router();

const eventService = require('../services/event.service');

// GET /api/events
// Query params: deviceId, userId, type, dateFrom, dateTo, page, limit
router.get('/', (req, res, next) => {
  try {
    const { deviceId, userId, type, dateFrom, dateTo } = req.query;
    const page  = parseInt(req.query.page  || '1',  10);
    const limit = parseInt(req.query.limit || '50', 10);

    const events = eventService.listEvents({
      deviceId, userId, type, dateFrom, dateTo, page, limit,
    });

    res.json({ data: events, count: events.length, page, limit });
  } catch (err) { next(err); }
});

// GET /api/events/attendance
router.get('/attendance', (req, res, next) => {
  try {
    const { dateFrom, dateTo, department } = req.query;
    const report = eventService.attendanceReport({ dateFrom, dateTo, department });
    res.json({ data: report });
  } catch (err) { next(err); }
});

module.exports = router;
