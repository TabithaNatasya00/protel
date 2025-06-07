const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authMiddleware');
const {
  saveGpsData,
  getGpsDataByUser
} = require('../controllers/gpsController');

// ✅ Middleware diletakkan sebagai parameter sebelum handler-nya
router.post('/', authenticateToken, saveGpsData);
router.get('/', authenticateToken, getGpsDataByUser);

module.exports = router;
