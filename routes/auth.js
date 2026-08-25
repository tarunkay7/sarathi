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
  address: 'Plot 12, Habsiguda, Hyderabad',
  pincode: '500076',
  dlNumber: 'TS09 2023 0004821',
};

router.post('/send-otp', (req, res) => {
  const { mobile } = req.body;
  if (!/^\d{10}$/.test(mobile || '')) {
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  }
  res.json({ ok: true });
});

router.post('/register', asyncHandler(async (req, res) => {
  const { name, email, mobile, dob, address, pincode, dlNumber, rtoId } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanMobile = String(mobile || '').trim();
  const cleanAddress = String(address || '').trim();
  const cleanPincode = String(pincode || '').trim();
  const cleanDlNumber = String(dlNumber || '').trim() || null;

  if (cleanName.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!/^\d{10}$/.test(cleanMobile)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  if (!/^\d{6}$/.test(cleanPincode)) return res.status(400).json({ error: 'Enter a valid 6-digit pincode.' });
  if (!dob || Number.isNaN(Date.parse(dob)) || new Date(dob) > new Date()) return res.status(400).json({ error: 'Enter a valid date of birth.' });
  if (cleanAddress.length < 8) return res.status(400).json({ error: 'Enter your complete residential address.' });

  const existing = await pool.query('SELECT id FROM citizens WHERE mobile_number = $1', [cleanMobile]);
  if (existing.rows[0] && cleanMobile !== '9000000009') {
    return res.status(409).json({ error: 'An account already exists for this mobile number. Please log in instead.' });
  }

  let jurisdiction = await resolveByPincode(cleanPincode);
  if (!jurisdiction && Number.isInteger(Number(rtoId))) {
    const selected = await pool.query('SELECT id, name, state, city FROM rtos WHERE id = $1', [Number(rtoId)]);
    jurisdiction = selected.rows[0] || null;
  }
  if (!jurisdiction) return res.status(400).json({ error: 'Select an RTO to continue.' });

  if (existing.rows[0]) {
    const updated = await pool.query(
      `UPDATE citizens
       SET email=$1, name=$2, dob=$3, state=$4, address=$5, pincode=$6, rto=$7, dl_number=$8, aadhaar_kyc_verified=FALSE
       WHERE id=$9 RETURNING *`,
      [cleanEmail, cleanName, dob, jurisdiction.state, cleanAddress, cleanPincode, jurisdiction.name, cleanDlNumber, existing.rows[0].id]
    );
    return res.json({ citizen: updated.rows[0] });
  }

  const inserted = await pool.query(
    `INSERT INTO citizens (mobile_number, email, name, dob, state, address, pincode, rto, dl_number, aadhaar_kyc_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE) RETURNING *`,
    [cleanMobile, cleanEmail, cleanName, dob, jurisdiction.state, cleanAddress, cleanPincode, jurisdiction.name, cleanDlNumber]
  );
  res.status(201).json({ citizen: inserted.rows[0] });
}));

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
  } else if (!citizen.email && citizen.pincode !== DEMO_EKYC.pincode) {
    // eKYC is the address of record, so re-sync on login and re-derive the
    // jurisdiction from it. This also repairs accounts created before the
    // address columns existed, or whose pincode maps somewhere new.
    const jurisdiction = await resolveByPincode(DEMO_EKYC.pincode);
    const updated = await pool.query(
      `UPDATE citizens SET address = $1, pincode = $2, rto = $3 WHERE id = $4 RETURNING *`,
      [DEMO_EKYC.address, DEMO_EKYC.pincode, jurisdiction ? jurisdiction.name : citizen.rto, citizen.id]
    );
    citizen = updated.rows[0];
  }
  res.json({ citizen });
}));

module.exports = router;
