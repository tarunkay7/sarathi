const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

router.post('/send-otp', (req, res) => {
  const { mobile } = req.body;
  if (!/^\d{10}$/.test(mobile || '')) {
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  }
  res.json({ ok: true });
});

router.post('/verify-otp', asyncHandler(async (req, res) => {
  const { mobile, otp } = req.body;
  if (otp !== '123456') {
    return res.status(401).json({ error: 'Incorrect OTP. For this demo use 123456.' });
  }

  const existing = await pool.query('SELECT * FROM citizens WHERE mobile_number = $1', [mobile]);
  let citizen = existing.rows[0];
  if (!citizen) {
    const inserted = await pool.query(
      `INSERT INTO citizens (mobile_number, name, dob, state, rto, dl_number)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [mobile, 'Ramesh Kumar', '1978-04-12', 'Telangana', 'Kukatpally', 'TS09 2023 0004821']
    );
    citizen = inserted.rows[0];
  }
  res.json({ citizen });
}));

module.exports = router;
