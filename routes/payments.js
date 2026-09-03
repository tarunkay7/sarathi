const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');
const psp = require('./psp');
const { applyPaymentEvent } = require('./payment-events');

const router = express.Router();

const LIVE = `status IN ('reconciling','paid')`;

// How long a payment may sit unresolved before a status poll stops waiting on
// the webhook and asks Razorpay directly. Deliveries normally arrive in under
// two seconds; this is the recovery path for one that never comes.
const RECONCILE_AFTER_MS = 8000;

function rupees(cents) {
  return '₹' + Math.round(cents / 100).toLocaleString('en-IN');
}

function requireInteger(value, res) {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return Number(value);
}

// The fee is the government's, not the caller's. It is read from the service
// the application is actually for, or from the challan's own amount, so a
// tampered request body cannot talk it down.
async function resolvePayable(body) {
  if (body && body.applicationId != null) {
    if (!/^\d+$/.test(String(body.applicationId))) return { error: 'Invalid id', status: 400 };
    const r = await pool.query(
      `SELECT a.id, a.reference_code, s.fee_cents
         FROM applications a JOIN services s ON s.key = a.service_key
        WHERE a.id = $1`,
      [Number(body.applicationId)]
    );
    if (!r.rows[0]) return { error: 'Not found', status: 404 };
    return {
      kind: 'application', column: 'application_id', id: r.rows[0].id,
      amountCents: r.rows[0].fee_cents, receipt: r.rows[0].reference_code,
    };
  }

  if (body && body.challanId != null) {
    if (!/^\d+$/.test(String(body.challanId))) return { error: 'Invalid id', status: 400 };
    const r = await pool.query(
      'SELECT id, challan_number, amount_cents, status FROM challans WHERE id = $1',
      [Number(body.challanId)]
    );
    if (!r.rows[0]) return { error: 'Not found', status: 404 };
    if (r.rows[0].status === 'paid') return { error: 'That challan is already paid.', status: 409 };
    return {
      kind: 'challan', column: 'challan_id', id: r.rows[0].id,
      amountCents: r.rows[0].amount_cents, receipt: r.rows[0].challan_number,
    };
  }

  return { error: 'Nothing to pay for.', status: 400 };
}

function findLive(column, id) {
  return pool.query(
    `SELECT * FROM payments WHERE ${column} = $1 AND ${LIVE} LIMIT 1`,
    [id]
  );
}

// The only function that writes a payment's resolution. The webhook and the
// reconcile both come through here, so they cannot reach different conclusions
// about the same row. The UPDATE is guarded on the status we read, so two
// callers racing produce one winner and the loser simply re-reads.
async function settle(payment, event) {
  const change = applyPaymentEvent({ payment, event });
  if (!change) return payment;

  // bank_ref is the gateway's own payment id -- the column the original schema
  // reserved for exactly this and the mock flow never filled. COALESCE keeps a
  // value we already hold if a later event arrives without one.
  const updated = await pool.query(
    `UPDATE payments
        SET status = $2,
            bank_ref = COALESCE($3, bank_ref),
            method = COALESCE($4, method),
            failure_reason = CASE WHEN $2 = 'failed' THEN $5 ELSE NULL END,
            confirmed_at = CASE WHEN $2 = 'paid' THEN now() ELSE confirmed_at END
      WHERE id = $1 AND status = $6
      RETURNING *`,
    [payment.id, change.status, change.psp_payment_id, change.method, change.reason, payment.status]
  );

  if (!updated.rows[0]) {
    const fresh = await pool.query('SELECT * FROM payments WHERE id = $1', [payment.id]);
    return fresh.rows[0] || payment;
  }

  const settled = updated.rows[0];
  if (change.status === 'paid') await onPaid(settled);
  return settled;
}

// Both status updates are guarded on the state they expect, so a replayed
// capture cannot regress an approved application or re-stamp a paid challan.
async function onPaid(payment) {
  if (payment.application_id) {
    await pool.query(
      `UPDATE applications SET status = 'under_review' WHERE id = $1 AND status = 'details'`,
      [payment.application_id]
    );
    await pool.query(
      `INSERT INTO timeline_events (application_id, label) VALUES ($1, $2)`,
      [payment.application_id, `Payment confirmed (${rupees(payment.amount_cents)})`]
    );
  }
  if (payment.challan_id) {
    await pool.query(
      `UPDATE challans SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'pending'`,
      [payment.challan_id]
    );
  }
}

async function reconcile(payment) {
  if (!payment.psp_order_id) return payment;
  let list;
  try {
    list = await psp.fetchOrderPayments(payment.psp_order_id);
  } catch (err) {
    // A gateway we cannot reach is not an answer. Leave the row alone and let
    // the next poll try again rather than inventing an outcome.
    console.warn('[payments] reconcile failed:', err.message);
    return payment;
  }
  const items = (list && list.items) || [];
  const chosen = items.find((p) => p.status === 'captured') || items.find((p) => p.status === 'failed');
  const event = psp.eventFromPayment(chosen);
  if (!event) return payment;
  return settle(payment, event);
}

router.post('/order', asyncHandler(async (req, res) => {
  if (!psp.configured()) {
    return res.status(501).json({ error: 'Payments are not configured on this server yet.' });
  }

  const payable = await resolvePayable(req.body);
  if (payable.error) return res.status(payable.status).json({ error: payable.error });

  // Retrying a slow payment returns the charge already in flight instead of
  // starting a second one.
  const existing = await findLive(payable.column, payable.id);
  if (existing.rows[0]) {
    return res.json({
      payment: existing.rows[0], keyId: psp.keyId(),
      orderId: existing.rows[0].psp_order_id, amountCents: existing.rows[0].amount_cents,
      reused: true,
    });
  }

  let order;
  try {
    order = await psp.createOrder({
      amountCents: payable.amountCents,
      receipt: payable.receipt,
      notes: { kind: payable.kind, id: String(payable.id) },
    });
  } catch (err) {
    console.error('[payments] order creation failed:', err.message);
    return res.status(502).json({ error: 'Could not reach the payment gateway just now. Please try again.' });
  }

  let payment;
  try {
    const inserted = await pool.query(
      `INSERT INTO payments (${payable.column}, amount_cents, status, psp_order_id)
       VALUES ($1,$2,'reconciling',$3) RETURNING *`,
      [payable.id, payable.amountCents, order.id]
    );
    payment = inserted.rows[0];
  } catch (err) {
    // 23505 is unique_violation. ON CONFLICT is avoided here on purpose:
    // arbiter inference against two partial indexes with IS NOT NULL
    // predicates is fragile, and catching the violation is unambiguous.
    if (err.code !== '23505') throw err;
    const winner = await findLive(payable.column, payable.id);
    return res.json({
      payment: winner.rows[0], keyId: psp.keyId(),
      orderId: winner.rows[0] && winner.rows[0].psp_order_id,
      amountCents: payable.amountCents, reused: true,
    });
  }

  res.status(201).json({
    payment, keyId: psp.keyId(), orderId: order.id, amountCents: payable.amountCents,
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;

  const result = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  let payment = result.rows[0];
  if (!payment) return res.status(404).json({ error: 'Not found' });

  // Self-healing instead of a scheduler: a webhook that never arrived is
  // recovered by the poll the citizen's browser is already making.
  const age = Date.now() - new Date(payment.created_at).getTime();
  if (payment.status === 'reconciling' && age > RECONCILE_AFTER_MS) {
    payment = await reconcile(payment);
  }
  res.json({ payment });
}));

// The browser may report that the citizen closed the popup. That can only ever
// fail a payment, never settle one -- and only one still reconciling, so a
// capture that already landed is not overwritten.
router.post('/:id/dismissed', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const result = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  const payment = result.rows[0];
  if (!payment) return res.status(404).json({ error: 'Not found' });
  res.json({ payment: await settle(payment, { type: 'client.dismissed' }) });
}));

// Mounted in server.js with express.raw() ahead of the global JSON parser,
// because the signature covers the raw bytes. This is the only path to 'paid'.
const webhook = asyncHandler(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!psp.verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    console.warn('[payments] webhook rejected: signature did not verify');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event = psp.eventFromWebhook(body);

  // All 38 event types are subscribed on this account. Anything we do not act
  // on is acknowledged so Razorpay stops retrying it for 24 hours.
  if (event.type !== 'payment.captured' && event.type !== 'payment.failed') {
    return res.json({ ok: true, ignored: event.type || 'unknown' });
  }
  if (!event.orderId) return res.json({ ok: true, ignored: 'no order id' });

  const found = await pool.query('SELECT * FROM payments WHERE psp_order_id = $1', [event.orderId]);
  const payment = found.rows[0];
  if (!payment) return res.json({ ok: true, ignored: 'unknown order' });

  await settle(payment, event);
  res.json({ ok: true });
});

module.exports = router;
module.exports.webhook = webhook;
