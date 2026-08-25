const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

function requireInteger(value, res) {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return Number(value);
}

// What the citizen can choose, not what they can send. Anything else is a
// malformed request rather than a 500 from a NOT NULL violation downstream.
const PAYMENT_METHODS = ['UPI', 'Card', 'Net banking'];

const LIVE_PAYMENT = `status IN ('reconciling','paid')`;

function findLivePayment(applicationId) {
  return pool.query(
    `SELECT * FROM payments WHERE application_id = $1 AND ${LIVE_PAYMENT} LIMIT 1`,
    [applicationId]
  );
}

router.post('/', asyncHandler(async (req, res) => {
  const { applicationId, method } = req.body;
  const id = requireInteger(applicationId, res);
  if (id === null) return;
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ error: 'Please choose a payment method to continue.' });
  }

  // The fee is the government's, not the caller's. It used to arrive in the
  // request body, so a tampered payload could pay ₹1 for a ₹400 renewal — the
  // amount is now read from the service the application is actually for.
  const feeResult = await pool.query(
    `SELECT s.fee_cents FROM applications a
     JOIN services s ON s.key = a.service_key
     WHERE a.id = $1`,
    [id]
  );
  if (!feeResult.rows[0]) return res.status(404).json({ error: 'Not found' });

  // Retrying a slow payment returns the charge already in flight instead of
  // starting a second one. The unique index is what actually guarantees this;
  // this lookup just avoids a pointless insert in the common case.
  const existing = await findLivePayment(id);
  if (existing.rows[0]) return res.json({ payment: existing.rows[0], reused: true });

  const inserted = await pool.query(
    `INSERT INTO payments (application_id, amount_cents, method, status)
     VALUES ($1,$2,$3,'reconciling')
     ON CONFLICT (application_id) WHERE ${LIVE_PAYMENT} DO NOTHING
     RETURNING *`,
    [id, feeResult.rows[0].fee_cents, method]
  );

  // Two requests raced and this one lost; the charge that landed is the one
  // that counts, so report it rather than failing the citizen's second tap.
  if (!inserted.rows[0]) {
    const winner = await findLivePayment(id);
    return res.json({ payment: winner.rows[0], reused: true });
  }
  res.status(201).json({ payment: inserted.rows[0] });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const result = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ payment: result.rows[0] });
}));

router.post('/:id/confirm', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;

  // Guarded so a repeated confirm cannot re-stamp confirmed_at or add a second
  // 'Payment confirmed' entry to the timeline the citizen reads.
  const paymentResult = await pool.query(
    `UPDATE payments SET status = 'paid', confirmed_at = now()
     WHERE id = $1 AND status <> 'paid' RETURNING *`,
    [id]
  );
  const payment = paymentResult.rows[0];
  if (!payment) {
    const current = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Not found' });
    return res.json({ payment: current.rows[0] });
  }

  await pool.query(`UPDATE applications SET status = 'under_review' WHERE id = $1`, [payment.application_id]);
  await pool.query(
    `INSERT INTO timeline_events (application_id, label) VALUES ($1, $2)`,
    [payment.application_id, `Payment confirmed (₹${(payment.amount_cents / 100).toFixed(0)})`]
  );
  res.json({ payment });
}));

module.exports = router;
