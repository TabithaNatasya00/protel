const pool = require('../db');

exports.calculateAndUpdatePace = async (ride_id) => {
  try {
    // Ambil jarak (km) dari realtime_stats
    const distanceResult = await pool.query(
      `SELECT distance FROM realtime_stats WHERE ride_id = $1`,
      [ride_id]
    );

    if (distanceResult.rows.length === 0) {
      throw new Error('Data distance tidak ditemukan di realtime_stats');
    }

    const distance = parseFloat(distanceResult.rows[0].distance);
    if (distance === 0) throw new Error('Distance 0, tidak bisa hitung pace');

    // Ambil durasi ride dalam menit
    const durationResult = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - started_at)) / 60 AS duration_minutes
       FROM rides WHERE id = $1 AND ended_at IS NULL`,
      [ride_id]
    );

    if (durationResult.rows.length === 0) {
      throw new Error('Ride tidak ditemukan atau sudah selesai');
    }

    const durationMinutes = parseFloat(durationResult.rows[0].duration_minutes);

    // Hitung pace (menit/km)
    const pace = durationMinutes / distance;

    // Update pace ke realtime_stats
    await pool.query(
      `UPDATE realtime_stats SET pace = $1, updated_at = NOW() WHERE ride_id = $2`,
      [pace, ride_id]
    );

    return { success: true, pace };
  } catch (err) {
    console.error('Gagal menghitung/mengupdate pace:', err.message);
    return { success: false, error: err.message };
  }
};
