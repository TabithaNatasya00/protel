const express = require('express');
const router = express.Router();
const { getRealtimeStats } = require('../controllers/realtimeController');
const authenticate = require('../middleware/authMiddleware');

router.get('/', authenticate, getRealtimeStats);

module.exports = router;
