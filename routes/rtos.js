const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

// Resolve the RTO with jurisdiction over an address pincode. Deliberately
// address-based rather than location-based: the Motor Vehicles Act ties the
// licensing authority to where the applicant ordinarily resides or carries on
// business, so a GPS fix would send a travelling applicant to an office that
// cannot process them.
async function resolveByPincode(pincode) {
  if (!/^\d{6}$/.test(String(pincode || ''))) return null;
  const found = await pool.query(
    `SELECT r.* FROM rto_pincodes p JOIN rtos r ON r.id = p.rto_id WHERE p.pincode = $1`,
    [pincode]
  );
  return found.rows[0] || null;
}

router.get('/', asyncHandler(async (req, res) => {
  const all = await pool.query('SELECT id, name, state, city FROM rtos ORDER BY state, name');
  res.json({ rtos: all.rows });
}));

router.get('/resolve', asyncHandler(async (req, res) => {
  const { pincode } = req.query;
  if (!/^\d{6}$/.test(String(pincode || ''))) {
    return res.status(400).json({ error: 'Enter a valid 6-digit pincode.' });
  }
  const rto = await resolveByPincode(pincode);
  if (!rto) {
    // No mapping is a normal outcome, not an error — the caller offers a
    // manual picker rather than guessing at jurisdiction.
    return res.json({ rto: null, resolved: false, reason: 'No RTO is mapped to this pincode yet.' });
  }
  res.json({ rto, resolved: true, basis: 'Address pincode on your Aadhaar eKYC record' });
}));

module.exports = router;
module.exports.resolveByPincode = resolveByPincode;
