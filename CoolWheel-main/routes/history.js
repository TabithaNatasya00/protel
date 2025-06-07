const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const historyController = require('../controllers/historyController');

router.get('/', auth, historyController.getAllHistory);
router.get('/dates', auth, historyController.getAvailableDateHistory); // Get all available dates
router.get('/:date', auth, historyController.getHistoryByDate); // format: YYYY-MM-DD

module.exports = router;
