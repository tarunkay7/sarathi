const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.post('/', async (req, res) => {
  const { applicationId, amountCents, method } = req.body;
  const inserted = await pool.query(
    `INSERT INTO payments (application_id, amount_cents, method, status)
     VALUES ($1,$2,$3,'reconciling') RETURNING *`,
    [applicationId, amountCents, method]
  );
  res.status(201).json({ payment: inserted.rows[0] });
});

router.get('/:id', async (req, res) => {
  const result = await pool.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ payment: result.rows[0] });
});

router.post('/:id/confirm', async (req, res) => {
  const paymentResult = await pool.query(
    `UPDATE payments SET status = 'paid', confirmed_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  const payment = paymentResult.rows[0];
  if (!payment) return res.status(404).json({ error: 'Not found' });

  await pool.query(`UPDATE applications SET status = 'under_review' WHERE id = $1`, [payment.application_id]);
  await pool.query(
    `INSERT INTO timeline_events (application_id, label) VALUES ($1, $2)`,
    [payment.application_id, `Payment confirmed (₹${(payment.amount_cents / 100).toFixed(0)})`]
  );
  res.json({ payment });
});

module.exports = router;
