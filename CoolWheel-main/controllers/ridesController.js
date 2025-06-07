const pool = require('../db');

exports.startRide = async (req, res) => {
  const user_id = req.user.user_id;

  if (!user_id) {
    return res.status(401).json({ error: "Unauthorized, user_id not found" });
  }

  try {
    // Cek apakah ada ride aktif (belum selesai) untuk user ini
    const activeRide = await pool.query(
      `SELECT * FROM rides WHERE user_id = $1 AND ended_at IS NULL AND is_active = true ORDER BY started_at DESC LIMIT 1`,
      [user_id]
    );
    if (activeRide.rows.length > 0) {
      // Sudah ada ride aktif, return error dan data ride aktif
      return res.status(400).json({
        error: "Masih ada ride yang aktif, tidak bisa memulai ride baru.",
        active_ride: activeRide.rows[0],
      });
    }
    // Jika tidak ada ride aktif, buat ride baru
    const result = await pool.query(
      "INSERT INTO rides (user_id, started_at, actual_started_at, is_active, is_paused, duration_accum) VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true, false, 0) RETURNING *",
      [user_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.endRide = async (req, res) => {
  const user_id = req.user.user_id;

  try {
    // 1. Ambil ride aktif
    const rideResult = await pool.query(
      `SELECT id, started_at, duration_accum FROM rides WHERE user_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [user_id]
    );

    if (rideResult.rows.length === 0) {
      return res.status(400).json({ error: "Tidak ada ride yang aktif" });
    }

    const ride = rideResult.rows[0];
    const ride_id = ride.id;
    const startTime = new Date(
      typeof ride.started_at === "string"
        ? ride.started_at + " UTC"
        : ride.started_at
    );
    const durationAccum = ride.duration_accum || 0;

    // 2. Ambil data GPS
    const gpsResult = await pool.query(
      `SELECT latitude, longitude, recorded_at FROM gps_points WHERE ride_id = $1 ORDER BY recorded_at ASC`,
      [ride_id]
    );
    const gpsPoints = gpsResult.rows;

    // 3. Hitung jarak & waktu
    const haversine = (a, b) => {
      const toRad = (deg) => (deg * Math.PI) / 180;
      const R = 6371e3;
      const dLat = toRad(b.lat - a.lat);
      const dLon = toRad(b.lng - a.lng);
      const φ1 = toRad(a.lat);
      const φ2 = toRad(b.lat);
      const a_ =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a_), Math.sqrt(1 - a_));
      return R * c;
    };

    let totalDistance = 0;
    let endTime = null;
    let lastSessionDuration = 0;
    if (gpsPoints.length >= 2) {
      const lastRecordedAt = gpsPoints[gpsPoints.length - 1].recorded_at;
      // Parse startTime dan endTime sebagai UTC tanpa menambah ' UTC' (karena Postgres timestamp tanpa zona waktu = UTC)
      const startTimeUTC = new Date(ride.started_at + "Z");
      const endTimeUTC = new Date(lastRecordedAt + "Z");
      endTime = endTimeUTC;
      lastSessionDuration = Math.round((endTimeUTC - startTimeUTC) / 1000); // detik
      for (let i = 1; i < gpsPoints.length; i++) {
        const prev = {
          lat: parseFloat(gpsPoints[i - 1].latitude),
          lng: parseFloat(gpsPoints[i - 1].longitude),
        };
        const curr = {
          lat: parseFloat(gpsPoints[i].latitude),
          lng: parseFloat(gpsPoints[i].longitude),
        };
        const d = haversine(prev, curr);
        if (d > 1) totalDistance += d;
      }
    }
    // Jika tidak ada GPS, gunakan waktu sekarang sebagai endTime
    if (!endTime) {
      const startTimeUTC = new Date(ride.started_at + "Z");
      endTime = new Date();
      lastSessionDuration = Math.round((endTime - startTimeUTC) / 1000);
    }

    // Total durasi = akumulasi + sesi terakhir
    const durationSec = durationAccum + lastSessionDuration;
    const durationHr = durationSec / 3600;

    const distanceKm = totalDistance / 1000;
    let pace = 0;
    if (distanceKm > 0 && durationHr > 0) {
      pace = distanceKm / durationHr;
    } else {
      pace = 0;
    }

    // 4. Ambil berat user
    const userResult = await pool.query(
      `SELECT weight FROM users WHERE id = $1`,
      [user_id]
    );
    const weight = userResult.rows[0]?.weight || 60;

    // 5. Ambil heart rate tertinggi
    const hrResult = await pool.query(
      `SELECT MAX(bpm) AS max_bpm FROM heartrates WHERE ride_id = $1`,
      [ride_id]
    );
    const maxHR = Math.round(hrResult.rows[0]?.max_bpm || 0);

    // 6. Hitung kalori
    let MET = 4.0;
    if (pace >= 20) MET = 8.0;
    else if (pace >= 16) MET = 6.8;
    if (maxHR >= 160) MET += 0.5;

    const calories = MET * weight * durationHr;
    const roundedCalories = parseFloat(calories.toFixed(2));
    const roundedDistance = parseFloat(distanceKm.toFixed(2));
    const roundedPace = parseFloat(pace.toFixed(2));

    // 7. Simpan ke history_rides
    await pool.query(
      `INSERT INTO ride_history (
        ride_id, duration, distance, pace, calories, max_heartrate,
        user_id, started_at, ended_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [
        ride_id,
        durationSec, // ⏱️ integer (detik)
        roundedDistance, // km
        roundedPace, // km/h
        roundedCalories, // kcal
        maxHR,
        user_id,
        ride.actual_started_at || startTime, // gunakan actual_started_at jika ada
      ]
    );

    // 8. Update ride jadi selesai dan simpan total durasi
    await pool.query(
      `UPDATE rides SET ended_at = CURRENT_TIMESTAMP, duration = 0, duration_accum = $1, is_active = false WHERE id = $2`,
      [durationSec, ride_id]
    );

    // 9. Format durasi jadi HH:MM:SS
    const formatDuration = (seconds) => {
      const h = Math.floor(seconds / 3600)
        .toString()
        .padStart(2, "0");
      const m = Math.floor((seconds % 3600) / 60)
        .toString()
        .padStart(2, "0");
      const s = (seconds % 60).toString().padStart(2, "0");
      return `${h}:${m}:${s}`;
    };

    const durationFormatted = formatDuration(durationSec);

    res.status(200).json({
      message: "Ride berhasil diakhiri dan disimpan ke history.",
      ride_id,
      duration: durationSec,
      duration_formatted: durationFormatted,
      distance: roundedDistance,
      pace: roundedPace,
      calories: roundedCalories,
      max_heartrate: maxHR,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getLiveDuration = async (req, res) => {
  const user_id = req.user.user_id;

  try {
    // Ambil ride aktif (apapun status is_paused)
    const result = await pool.query(
      `SELECT id, started_at, is_paused, duration, EXTRACT(EPOCH FROM (NOW() - started_at)) AS duration_seconds
       FROM rides
       WHERE user_id = $1 AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Tidak ada ride aktif" });
    }

    const ride = result.rows[0];
    const ride_id = ride.id;
    let durationSeconds;
    let status;

    if (ride.is_paused) {
      // Jika paused, gunakan duration yang sudah tercatat (dalam detik)
      durationSeconds = ride.duration || 0;
      status = "paused";
    } else {
      // Jika aktif, hitung durasi berjalan
      durationSeconds = Math.floor(ride.duration_seconds);
      status = "active";
      // Update kolom duration dalam DETIK
      await pool.query(`UPDATE rides SET duration = $1 WHERE id = $2`, [
        durationSeconds,
        ride_id,
      ]);
    }

    const durationMinutes = Math.floor(durationSeconds / 60);
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    const seconds = durationSeconds % 60;

    res.json({
      ride_id,
      status,
      duration_minutes: durationMinutes,
      formatted: `${hours}h ${minutes}m ${seconds}s`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.pauseRide = async (req, res) => {
  const user_id = req.user.user_id;

  try {
    // Cari ride aktif yang belum di-pause dan belum selesai
    const rideResult = await pool.query(
      `SELECT id, started_at FROM rides WHERE user_id = $1 AND ended_at IS NULL AND is_paused = false ORDER BY started_at DESC LIMIT 1`,
      [user_id]
    );

    if (rideResult.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "Tidak ada ride aktif yang bisa di-pause" });
    }

    const ride_id = rideResult.rows[0].id;

    // Update ride menjadi paused dan set paused_at ke CURRENT_TIMESTAMP
    await pool.query(
      `UPDATE rides SET is_paused = true, paused_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [ride_id]
    );

    // Ambil kembali started_at dan paused_at dari DB
    const timeResult = await pool.query(
      `SELECT started_at, paused_at FROM rides WHERE id = $1`,
      [ride_id]
    );
    const started_at_raw = timeResult.rows[0].started_at;
    const paused_at_raw = timeResult.rows[0].paused_at;
    const startTime = new Date(
      typeof started_at_raw === "string"
        ? started_at_raw + " UTC"
        : started_at_raw
    );
    const pausedTime = new Date(
      typeof paused_at_raw === "string" ? paused_at_raw + " UTC" : paused_at_raw
    );
    const durationSeconds = Math.floor((pausedTime - startTime) / 1000);

    // Simpan duration (detik) ke DB
    await pool.query(`UPDATE rides SET duration = $1 WHERE id = $2`, [
      durationSeconds,
      ride_id,
    ]);

    res.status(200).json({
      message: "Ride berhasil di-pause",
      ride_id,
      duration_seconds: durationSeconds,
      paused_at: paused_at_raw,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.resumeRide = async (req, res) => {
  const user_id = req.user.user_id;

  try {
    // Cari ride yang di-pause
    const rideResult = await pool.query(
      `SELECT id, duration, duration_accum FROM rides WHERE user_id = $1 AND ended_at IS NULL AND is_paused = true ORDER BY started_at DESC LIMIT 1`,
      [user_id]
    );

    if (rideResult.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "Tidak ada ride yang sedang di-pause" });
    }

    const ride_id = rideResult.rows[0].id;
    const prevDuration = rideResult.rows[0].duration || 0;
    const prevAccum = rideResult.rows[0].duration_accum || 0;
    const newAccum = prevAccum + prevDuration;

    // Update ride: is_paused = false, started_at = CURRENT_TIMESTAMP, duration_accum = newAccum
    await pool.query(
      `UPDATE rides SET is_paused = false, started_at = CURRENT_TIMESTAMP, duration = 0, duration_accum = $1 WHERE id = $2`,
      [newAccum, ride_id]
    );

    res.status(200).json({
      message: "Ride berhasil dilanjutkan (resume)",
      ride_id,
      duration_accum: newAccum,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
