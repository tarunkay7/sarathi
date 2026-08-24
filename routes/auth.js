const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');
const { resolveByPincode } = require('./rtos');

const router = express.Router();

// Stands in for the address an Aadhaar eKYC response would return. The RTO is
// derived from its pincode rather than stored by hand, so the jurisdiction
// rule is exercised for real in the demo.
const DEMO_EKYC = {
  name: 'Ramesh Kumar',
  dob: '1978-04-12',
  state: 'Telangana',
  address: 'Plot 42, KPHB Colony, Kukatpally, Hyderabad',
  pincode: '500072',
  dlNumber: 'TS09 2023 0004821',
};

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
    const jurisdiction = await resolveByPincode(DEMO_EKYC.pincode);
    const inserted = await pool.query(
      `INSERT INTO citizens (mobile_number, name, dob, state, address, pincode, rto, dl_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        mobile,
        DEMO_EKYC.name,
        DEMO_EKYC.dob,
        DEMO_EKYC.state,
        DEMO_EKYC.address,
        DEMO_EKYC.pincode,
        jurisdiction ? jurisdiction.name : null,
        DEMO_EKYC.dlNumber,
      ]
    );
    citizen = inserted.rows[0];
  } else if (!citizen.pincode) {
    // Backfill accounts created before the address/pincode columns existed so
    // their RTO is derived the same way as new ones.
    const jurisdiction = await resolveByPincode(DEMO_EKYC.pincode);
    const updated = await pool.query(
      `UPDATE citizens SET address = $1, pincode = $2, rto = COALESCE(rto, $3)
       WHERE id = $4 RETURNING *`,
      [DEMO_EKYC.address, DEMO_EKYC.pincode, jurisdiction ? jurisdiction.name : null, citizen.id]
    );
    citizen = updated.rows[0];
  }
  res.json({ citizen });
}));

module.exports = router;
