const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

// Issuing or extending a licence is blocked by an unpaid fine; replacing a lost
// document or taking a first learner's test is not. Exported so the application
// route enforces exactly the same rule rather than a second copy of it.
const BLOCKED_SERVICES = ['renew', 'dl'];

function requireInteger(value, res) {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return Number(value);
}

async function pendingChallan(citizenId) {
  const result = await pool.query(
    `SELECT * FROM challans WHERE citizen_id = $1 AND status = 'pending'
     ORDER BY issued_on LIMIT 1`,
    [citizenId]
  );
  return result.rows[0] || null;
}

router.get('/citizen/:id', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const result = await pool.query(
    'SELECT * FROM challans WHERE citizen_id = $1 ORDER BY issued_on DESC',
    [id]
  );
  res.json({ challans: result.rows });
}));

// Not a row in payments: that table requires an application_id and a challan has
// none. The status guard makes this idempotent — a second call matches nothing.
router.post('/:id/pay', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const settled = await pool.query(
    `UPDATE challans SET status = 'paid', paid_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id]
  );
  if (settled.rows[0]) return res.json({ challan: settled.rows[0] });

  const existing = await pool.query('SELECT * FROM challans WHERE id = $1', [id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ challan: existing.rows[0], alreadyPaid: true });
}));

module.exports = router;
module.exports.pendingChallan = pendingChallan;
module.exports.BLOCKED_SERVICES = BLOCKED_SERVICES;
