'use strict';

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const router  = express.Router();

const userService = require('../services/user.service');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  next();
}

// GET /api/users
router.get('/', (req, res, next) => {
  try {
    const users = userService.listUsers({ department: req.query.department });
    res.json({ data: users, count: users.length });
  } catch (err) { next(err); }
});

// GET /api/users/:id
router.get('/:id', (req, res, next) => {
  try {
    const user = userService.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ data: user });
  } catch (err) { next(err); }
});

// POST /api/users
router.post('/',
  body('employee_id').notEmpty().trim(),
  body('full_name').notEmpty().trim(),
  validate,
  (req, res, next) => {
    try {
      const id = userService.createUser(req.body);
      res.status(201).json({ success: true, id });
    } catch (err) {
      if (err.message.includes('already exists')) return res.status(409).json({ error: err.message });
      next(err);
    }
  }
);

// PUT /api/users/:id
router.put('/:id',
  body('full_name').optional().notEmpty().trim(),
  validate,
  (req, res, next) => {
    try {
      userService.updateUser(req.params.id, req.body);
      res.json({ success: true });
    } catch (err) {
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      next(err);
    }
  }
);

// DELETE /api/users/:id
router.delete('/:id', (req, res, next) => {
  try {
    const user = userService.deleteUser(req.params.id);
    res.json({ success: true, deleted: user });
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    next(err);
  }
});

// POST /api/users/:id/sync/:deviceId
router.post('/:id/sync/:deviceId', async (req, res, next) => {
  try {
    const result = await userService.syncUserToDevice(req.params.id, req.params.deviceId);
    res.json(result);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    next(err);
  }
});

// POST /api/users/bulk-sync
router.post('/bulk-sync',
  body('userId').notEmpty(),
  validate,
  async (req, res, next) => {
    try {
      const results = await userService.bulkSync(req.body.userId);
      res.json({ results });
    } catch (err) { next(err); }
  }
);

module.exports = router;
