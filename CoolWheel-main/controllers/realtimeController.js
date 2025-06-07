const pool = require('../db');

function haversineDistance(coord1, coord2) {
  const toRad = x => x * Math.PI / 180;
  const R = 6371e3;
  const φ1 = toRad(coord1.lat);
  const φ2 = toRad(coord2.lat);
  const Δφ = toRad(coord2.lat - coord1.lat);
  const Δλ = toRad(coord2.lng - coord1.lng);

  const a = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

exports.getRealtimeStats = async (req, res) => {
  const user_id = req.user.user_id;

  try {
    // 1. Cek ride aktif
    const rideResult = await pool.query(
      `SELECT id FROM rides WHERE user_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [user_id]
    );
    if (rideResult.rows.length === 0) {
      return res.status(400).json({ error: 'Tidak ada ride yang aktif' });
    }

    const ride_id = rideResult.rows[0].id;

    // 2. Ambil GPS points
    const gpsResult = await pool.query(
      `SELECT latitude, longitude, recorded_at FROM gps_points WHERE ride_id = $1 ORDER BY recorded_at ASC`,
      [ride_id]
    );
    const gpsPoints = gpsResult.rows;

    let totalDistance = 0;
    let startTime = null;
    let endTime = null;

    if (gpsPoints.length >= 2) {
      startTime = new Date(gpsPoints[0].recorded_at);
      endTime = new Date(gpsPoints[gpsPoints.length - 1].recorded_at);
      for (let i = 1; i < gpsPoints.length; i++) {
        const prev = {
          lat: parseFloat(gpsPoints[i - 1].latitude),
          lng: parseFloat(gpsPoints[i - 1].longitude)
        };
        const curr = {
          lat: parseFloat(gpsPoints[i].latitude),
          lng: parseFloat(gpsPoints[i].longitude)
        };
        const d = haversineDistance(prev, curr);
        if (d > 1) totalDistance += d;
      }
    }

    const distanceKm = totalDistance / 1000;
    let durationHours = 0;
    if (startTime && endTime) {
      durationHours = (endTime - startTime) / (1000 * 60 * 60);
    }

    const pace = durationHours > 0 ? (durationHours / distanceKm) * 60 : 0;

    // 3. Ambil berat user
    const userResult = await pool.query(
      `SELECT weight FROM users WHERE id = $1`,
      [user_id]
    );
    const weight = userResult.rows[0]?.weight || 60;

    // 4. Ambil last heartrate
    const hrResult = await pool.query(
      `SELECT bpm FROM heartrates WHERE ride_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [ride_id]
    );
    const lastHeartrate = hrResult.rows[0]?.bpm || null;

    // 5. Tentukan MET
    let MET = 4.0;
    if (pace >= 20) {
      MET = 8.0;
    } else if (pace >= 16) {
      MET = 6.8;
    }

    // Tambahan jika HR tinggi → naikkan MET
    if (lastHeartrate >= 160) {
      MET += 0.5;
    }

    // 6. Hitung kalori
    const calories = MET * weight * durationHours;

    res.status(200).json({
      distance: parseFloat(distanceKm.toFixed(2)),   // km
      pace: parseFloat(pace.toFixed(2)),             // km/jam
      calories: Math.round(calories),                // kcal
      last_heartrate: lastHeartrate
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
