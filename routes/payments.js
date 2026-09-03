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
// about the same row. Everything runs in one transaction: a half-applied
// settlement is worse than a retried one, because Razorpay's redelivery would
// find the row already 'paid' and skip the side effects for good.
async function settle(payment, event) {
  const change = applyPaymentEvent({ payment, event });
  if (!change) return payment;

  // Order-id linkage alone would let a capture for the wrong amount settle a
  // fee it does not cover. Refuse rather than guess; the row stays as it was
  // and the mismatch is loud in the log.
  if (change.status === 'paid' && event.amount != null
      && Number(event.amount) !== payment.amount_cents) {
    console.error(
      `[payments] amount mismatch on payment ${payment.id}: captured ${event.amount}, ` +
      `expected ${payment.amount_cents}. Not settling.`
    );
    return payment;
  }

  const column = payment.application_id ? 'application_id' : 'challan_id';
  const payableId = payment.application_id || payment.challan_id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (change.status === 'paid') {
      // A capture is money that actually moved, so it outranks every attempt
      // that did not. Without this the partial unique index rejects the one
      // payment that really happened: a citizen who dismissed the popup and
      // retried leaves a live second row, and the first payment's capture
      // then collides with it.
      await client.query(
        `UPDATE payments
            SET status = 'failed',
                failure_reason = 'Superseded by an earlier payment that completed.'
          WHERE ${column} = $1 AND id <> $2 AND status = 'reconciling'`,
        [payableId, payment.id]
      );

      // A different row already settled this payable, so this is a second real
      // charge rather than a redelivery of the first. The citizen has been
      // debited twice. Park it where a human can see it instead of discarding
      // a capture we cannot represent.
      const alreadyPaid = await client.query(
        `SELECT id FROM payments WHERE ${column} = $1 AND id <> $2 AND status = 'paid' LIMIT 1`,
        [payableId, payment.id]
      );
      if (alreadyPaid.rows[0]) {
        const parked = await client.query(
          `UPDATE payments
              SET status = 'refund_in_progress',
                  bank_ref = COALESCE($2, bank_ref),
                  method = COALESCE($3, method),
                  failure_reason = $4
            WHERE id = $1 AND status = $5
            RETURNING *`,
          [
            payment.id, change.psp_payment_id, change.method,
            `Captured after payment ${alreadyPaid.rows[0].id} had already settled this payable. Needs a refund.`,
            payment.status,
          ]
        );
        await client.query('COMMIT');
        console.error(
          `[payments] DOUBLE CAPTURE: payment ${payment.id} captured while ` +
          `${alreadyPaid.rows[0].id} was already paid for the same payable. Refund required.`
        );
        return parked.rows[0] || payment;
      }
    }

    // Compare-and-set on the status we read, so two writers racing produce one
    // winner and the loser re-reads instead of clobbering.
    const updated = await client.query(
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
      await client.query('ROLLBACK');
      const fresh = await pool.query('SELECT * FROM payments WHERE id = $1', [payment.id]);
      return fresh.rows[0] || payment;
    }

    const settled = updated.rows[0];
    if (change.status === 'paid') await onPaid(client, settled);
    await client.query('COMMIT');
    return settled;
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

// Runs inside settle()'s transaction on the same client, so the status write
// and these side effects commit or roll back together. Both updates are
// guarded on the state they expect, so a redelivery cannot regress an approved
// application or re-stamp a settled challan.
async function onPaid(client, payment) {
  if (payment.application_id) {
    await client.query(
      `UPDATE applications SET status = 'under_review' WHERE id = $1 AND status = 'details'`,
      [payment.application_id]
    );
    await client.query(
      `INSERT INTO timeline_events (application_id, label) VALUES ($1, $2)`,
      [payment.application_id, `Payment confirmed (${rupees(payment.amount_cents)})`]
    );
  }
  if (payment.challan_id) {
    await client.query(
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
    // 23505 is unique_violation, but three different indexes can raise it here.
    // Only the two live-payment indexes mean "a charge is already in flight";
    // a psp_order_id collision is a genuine fault and must not be reported to
    // the citizen as a successful reuse.
    const liveIndexes = ['payments_one_live_per_application', 'payments_one_live_per_challan'];
    if (err.code !== '23505' || !liveIndexes.includes(err.constraint)) throw err;

    const winner = await findLive(payable.column, payable.id);
    if (!winner.rows[0]) {
      // The racing row left the live predicate between the violation and this
      // read. Returning 200 with no payment would make the client throw on
      // created.payment.id.
      return res.status(409).json({ error: 'That payment just changed state. Please try again.' });
    }
    return res.json({
      payment: winner.rows[0], keyId: psp.keyId(),
      orderId: winner.rows[0].psp_order_id,
      amountCents: winner.rows[0].amount_cents, reused: true,
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
