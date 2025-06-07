const jwt = require('jsonwebtoken');
const pool = require('../db');

module.exports = async function (req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token tidak ditemukan' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.user_id;

    const result = await pool.query('SELECT token FROM users WHERE id = $1', [userId]);
    const savedToken = result.rows[0]?.token;

    if (!savedToken || savedToken !== token) {
      return res.status(403).json({ error: 'Token tidak valid atau sudah diganti dari device lain' });
    }

    req.user = { user_id: userId };
    next();
  } catch (err) {
    res.status(403).json({ error: 'Token tidak valid' });
  }
};
