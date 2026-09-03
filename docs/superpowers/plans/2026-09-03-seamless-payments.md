# Seamless Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A citizen pays a licence fee or a pending challan in two taps through a real Razorpay checkout popup, and the payment is confirmed by a signature-verified webhook rather than by their browser.

**Architecture:** One `payments` ledger covers both payables (application fee and challan) via mutually exclusive `application_id` / `challan_id` columns. A pure `applyPaymentEvent` function is the sole decider of what a payment event means; a single `settle()` writer applies it, so the webhook and the reconcile-on-poll converge instead of fighting. The browser can open a popup and report a dismissal, but has no path to `paid`.

**Tech Stack:** Node 20+ (`node:test`, global `fetch`, `node:crypto`), Express 4, Postgres (node-pg), Razorpay Orders API + Standard Checkout, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-seamless-payments-design.md`

## Global Constraints

- **Razorpay test mode only, permanently.** Live keys require business KYC and would mean collecting real money for simulated government fees.
- **The amount is always derived server-side** from the application's service fee or the challan's `amount_cents`. It is never read from the request body.
- **The browser can never move a payment to `paid`.** Only a signature-verified webhook, or a server-initiated reconcile against Razorpay's API, may do so.
- **`DATABASE_URL` is a live production Neon instance shared by the Pi and Render deployments and holds data under judging.** No `DROP TABLE`, `TRUNCATE`, `DELETE`, or unguarded `UPDATE`. Schema changes are additive and idempotent; `db/schema.sql` is re-run on every deploy.
- **Tests never touch the database.** Domain logic is extracted as pure functions and tested with fixtures, following `computeAttention` in `routes/attention.js`.
- **`.env` is gitignored and must never be committed.** Never echo a secret's value into terminal output, a commit message, or a test fixture.
- Webhook signature verification runs over the **raw request body**.
- **No new npm dependencies.** Razorpay's REST API is called with global `fetch`; do not install the `razorpay` SDK.
- **`amount_cents` maps 1:1 to Razorpay's `amount`.** Both are paise. ₹400 is `40000` in each. Do not multiply or divide by 100 at the boundary — verified against the live test API on 2026-09-03 (`order_TXc1I6DUfoKAhk`, `amount: 40000`).
- **Key on `payment.captured`, never `payment.authorized`.** All 38 event types are subscribed on this account and `authorized` fires before the money is captured.
- **Acknowledge unhandled webhook event types with HTTP 200.** Anything else makes Razorpay retry disputes, settlements, and rewards events for 24 hours.

## Known broken window

Task 4 deletes `POST /api/payments/:id/confirm`, which `public/app.js:534` still calls. **Between Task 4 and Task 5 the payment UI is broken.** This is expected for a trust-boundary change and must not be "fixed" by re-adding `confirm` — Task 5 closes it. Do not stop the plan between those two tasks.

## File structure

| File | Responsibility |
|---|---|
| `db/schema.sql` | Append-only idempotent migration. Generalises `payments` to two payable types. |
| `routes/payment-events.js` (new) | Pure. The only place that decides what a payment event means. No DB, no Express, no HTTP. |
| `routes/psp.js` (new) | Pure/HTTP. Razorpay REST calls, signature verification, and normalising Razorpay shapes into our event shape. No DB, no Express, no domain rules. |
| `routes/payments.js` | Express + DB. Order creation, status poll with reconcile, dismissal, webhook. Single `settle()` writer. |
| `routes/challans.js` | Loses `POST /:id/pay`. Keeps the blocker helpers. |
| `routes/attention.js` | Challan query gains `payment_status`; `computeAttention` reads it. |
| `public/app.js` | Checkout launch, dismissal reporting, status poll. |
| `public/index.html` | Pay panel on intake step 3; `screen-pay` removed; disclaimer corrected. |
| `public/styles.css` | Pay panel styling. |
| `server.js` | Raw-body webhook mount ahead of `express.json()`. |
| `test/payment-events.test.js` (new) | Pure tests for the event decider. |
| `test/psp.test.js` (new) | Pure tests for signature verification and shape normalising. |

---

### Task 1: Schema migration

**Files:**
- Modify: `db/schema.sql` (append at end, after the `ALTER TABLE grievances ADD COLUMN IF NOT EXISTS source TEXT;` line)

**Interfaces:**
- Consumes: nothing.
- Produces: `payments.challan_id`, `payments.psp_order_id`, `payments.psp_payment_id`; nullable `payments.application_id` and `payments.method`; indexes `payments_one_live_per_application`, `payments_one_live_per_challan`, `payments_psp_order`; constraint `payments_one_payable`.

- [ ] **Step 1: Append the migration**

Append to `db/schema.sql`:

```sql
-- Payments now cover two kinds of payable: an application fee and a challan.
-- Exactly one of the two id columns is set on any row, which the CHECK below
-- enforces rather than trusting callers. method becomes nullable because at
-- order-creation time nobody knows how the citizen will choose to pay --
-- Razorpay reports that on capture.
ALTER TABLE payments ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN method         DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS challan_id     INTEGER REFERENCES challans(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS psp_order_id   TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS psp_payment_id TEXT;

-- ADD CONSTRAINT has no IF NOT EXISTS, and this file is re-run on every
-- deploy, so the second migration would fail without this wrapper.
DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_one_payable
    CHECK ((application_id IS NULL) <> (challan_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One live payment per payable, per kind. This is what actually makes a second
-- tap return the charge already in flight rather than starting another one.
DROP INDEX IF EXISTS payments_one_live_per_application;
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_live_per_application ON payments (application_id)
  WHERE application_id IS NOT NULL AND status IN ('reconciling','paid');
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_live_per_challan ON payments (challan_id)
  WHERE challan_id IS NOT NULL AND status IN ('reconciling','paid');

-- Razorpay retries webhook deliveries for 24 hours. A unique order id is what
-- makes a replayed delivery a no-op instead of a second payment row.
CREATE UNIQUE INDEX IF NOT EXISTS payments_psp_order ON payments (psp_order_id)
  WHERE psp_order_id IS NOT NULL;
```

- [ ] **Step 2: Run the migration**

Run: `npm run db:migrate`
Expected: `Schema applied.`

- [ ] **Step 3: Run it again — idempotency is the whole point**

Run: `npm run db:migrate`
Expected: `Schema applied.` again, with no error. If this fails, the `DO $$` wrapper is wrong.

- [ ] **Step 4: Verify the shape changed and existing rows survived**

Run:

```bash
node -e '
require("dotenv").config();const p=require("./db/pool");
(async()=>{
 const c=await p.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",["payments"]);
 c.rows.forEach(r=>console.log(r.column_name.padEnd(18)+r.is_nullable));
 const n=await p.query("SELECT count(*) n FROM payments");
 console.log("rows preserved: "+n.rows[0].n);
 process.exit(0);})();'
```

Expected: `challan_id`, `psp_order_id`, `psp_payment_id` present; `application_id` and `method` now `YES` (nullable); `rows preserved: 5`.

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql
git commit -m "Let one payments ledger cover fees and challans"
```

---

### Task 2: The pure event decider

**Files:**
- Create: `routes/payment-events.js`
- Test: `test/payment-events.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `applyPaymentEvent({ payment, event })` → `null` when nothing changes, else `{ status: 'paid'|'failed', psp_payment_id: string|null, method: string|null, reason: string|null }`.
  - `methodLabel(raw)` → display string or `null`.
  - `event` shape: `{ type: string, paymentId?: string, method?: string, reason?: string }`.
  - `payment` shape: only `.status` is read.

- [ ] **Step 1: Write the failing tests**

Create `test/payment-events.test.js`:

```js
// The single decider for what a payment event means, tested without Postgres.
// DATABASE_URL points at the live instance both deployments serve from, so no
// test may go near it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPaymentEvent, methodLabel } = require('../routes/payment-events');

const reconciling = { id: 1, status: 'reconciling' };

test('a capture on a reconciling payment settles it as paid', () => {
  const change = applyPaymentEvent({
    payment: reconciling,
    event: { type: 'payment.captured', paymentId: 'pay_ABC', method: 'upi' },
  });
  assert.equal(change.status, 'paid');
  assert.equal(change.psp_payment_id, 'pay_ABC');
  assert.equal(change.method, 'UPI');
});

test('a replayed capture on an already-paid payment changes nothing', () => {
  // Razorpay retries deliveries for 24 hours. Without this, a retry would
  // re-stamp confirmed_at and add a second timeline entry the citizen reads.
  const change = applyPaymentEvent({
    payment: { id: 1, status: 'paid' },
    event: { type: 'payment.captured', paymentId: 'pay_ABC', method: 'upi' },
  });
  assert.equal(change, null);
});

test('a failure on a reconciling payment marks it failed with a reason', () => {
  const change = applyPaymentEvent({
    payment: reconciling,
    event: { type: 'payment.failed', paymentId: 'pay_X', method: 'card', reason: 'Card declined' },
  });
  assert.equal(change.status, 'failed');
  assert.equal(change.reason, 'Card declined');
});

test('a dismissal on a reconciling payment marks it failed so a retry is possible', () => {
  // Nothing in the codebase ever set 'failed' before. A dismissed popup left
  // the row in 'reconciling', the partial unique index held, and the citizen
  // could never pay that payable again.
  const change = applyPaymentEvent({
    payment: reconciling,
    event: { type: 'client.dismissed' },
  });
  assert.equal(change.status, 'failed');
  assert.match(change.reason, /closed the payment window/);
});

test('a capture arriving after a dismissal still wins', () => {
  // A citizen can dismiss the popup after their UPI app has already completed
  // the payment. Money moved, so the capture must beat our guess -- the
  // alternative is telling someone who paid that they did not.
  const change = applyPaymentEvent({
    payment: { id: 1, status: 'failed' },
    event: { type: 'payment.captured', paymentId: 'pay_LATE', method: 'upi' },
  });
  assert.equal(change.status, 'paid');
  assert.equal(change.psp_payment_id, 'pay_LATE');
});

test('a repeated failure on an already-failed payment changes nothing', () => {
  const change = applyPaymentEvent({
    payment: { id: 1, status: 'failed' },
    event: { type: 'payment.failed', reason: 'Card declined' },
  });
  assert.equal(change, null);
});

test('an unhandled event type changes nothing', () => {
  // 38 event types are subscribed on this account: disputes, settlements,
  // rewards. They must be inert, not errors.
  for (const type of ['settlement.processed', 'payment.dispute.created', 'payment.authorized']) {
    assert.equal(applyPaymentEvent({ payment: reconciling, event: { type } }), null, type);
  }
});

test('an unknown method is passed through rather than dropped', () => {
  assert.equal(methodLabel('upi'), 'UPI');
  assert.equal(methodLabel('netbanking'), 'Net banking');
  assert.equal(methodLabel('paylater'), 'paylater');
  assert.equal(methodLabel(null), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../routes/payment-events'`

- [ ] **Step 3: Write the implementation**

Create `routes/payment-events.js`:

```js
// The only place that decides what a payment event means. Pure, so it can be
// tested without Postgres, and shared by the webhook and the reconcile-on-poll
// so two writers racing on one row converge instead of disagreeing.

const METHOD_LABELS = {
  upi: 'UPI',
  card: 'Card',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  emi: 'EMI',
  bank_transfer: 'Bank transfer',
};

function methodLabel(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase();
  return METHOD_LABELS[key] || String(raw);
}

function applyPaymentEvent({ payment, event }) {
  if (!payment || !event || !event.type) return null;

  // Terminal. Razorpay retries deliveries for 24 hours, so a replayed capture
  // has to be inert rather than a second confirmation.
  if (payment.status === 'paid') return null;

  // Deliberately reachable from 'failed' as well as 'reconciling'. A citizen
  // can dismiss the popup after their UPI app has already completed the
  // payment, which marks the row failed moments before the capture lands.
  // Money moved, so the capture wins.
  if (event.type === 'payment.captured') {
    return {
      status: 'paid',
      psp_payment_id: event.paymentId || null,
      method: methodLabel(event.method),
      reason: null,
    };
  }

  if (payment.status !== 'reconciling') return null;

  if (event.type === 'payment.failed') {
    return {
      status: 'failed',
      psp_payment_id: event.paymentId || null,
      method: methodLabel(event.method),
      reason: event.reason || 'The payment did not go through.',
    };
  }

  if (event.type === 'client.dismissed') {
    return {
      status: 'failed',
      psp_payment_id: null,
      method: null,
      reason: 'You closed the payment window before it finished.',
    };
  }

  // Settlements, disputes, rewards, and payment.authorized all arrive here.
  // Inert by design.
  return null;
}

module.exports = { applyPaymentEvent, methodLabel };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests pass, including the pre-existing 29.

- [ ] **Step 5: Commit**

```bash
git add routes/payment-events.js test/payment-events.test.js
git commit -m "Decide what a payment event means in one pure place"
```

---

### Task 3: The Razorpay client

**Files:**
- Create: `routes/psp.js`
- Test: `test/psp.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `configured()` → boolean
  - `keyId()` → string | undefined
  - `createOrder({ amountCents, receipt, notes })` → Razorpay order object (has `.id`); throws on non-2xx
  - `fetchOrderPayments(orderId)` → `{ items: [...] }`; throws on non-2xx
  - `verifyWebhookSignature(rawBody, signature)` → boolean
  - `eventFromWebhook(body)` → `{ type, orderId, paymentId, method, reason }`
  - `eventFromPayment(razorpayPayment)` → event object or `null` when unresolved

- [ ] **Step 1: Write the failing tests**

Create `test/psp.test.js`:

```js
// Signature verification and shape-normalising, tested without network or
// database. The HMAC below is computed in the test rather than pasted, so the
// test proves the algorithm rather than pinning a magic string.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';
const psp = require('../routes/psp');

function sign(raw, secret) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

test('a correctly signed body verifies', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  assert.equal(psp.verifyWebhookSignature(raw, sign(raw, 'test-webhook-secret')), true);
});

test('a body signed with the wrong secret is rejected', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  assert.equal(psp.verifyWebhookSignature(raw, sign(raw, 'not-the-secret')), false);
});

test('a tampered body is rejected under a valid-looking signature', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  const signature = sign(raw, 'test-webhook-secret');
  const tampered = Buffer.from(JSON.stringify({ event: 'payment.captured', extra: 1 }));
  assert.equal(psp.verifyWebhookSignature(tampered, signature), false);
});

test('a missing or malformed signature is rejected rather than throwing', () => {
  const raw = Buffer.from('{}');
  assert.equal(psp.verifyWebhookSignature(raw, undefined), false);
  assert.equal(psp.verifyWebhookSignature(raw, ''), false);
  assert.equal(psp.verifyWebhookSignature(raw, 'short'), false);
});

test('a webhook body is normalised into our event shape', () => {
  const event = psp.eventFromWebhook({
    event: 'payment.captured',
    payload: { payment: { entity: {
      id: 'pay_ABC', order_id: 'order_XYZ', method: 'upi', error_description: null,
    } } },
  });
  assert.deepEqual(event, {
    type: 'payment.captured', orderId: 'order_XYZ',
    paymentId: 'pay_ABC', method: 'upi', reason: null,
  });
});

test('a webhook body with no payment entity still yields a type', () => {
  // settlement.processed and the rewards events carry no payment entity. They
  // must normalise without throwing so the route can acknowledge and ignore.
  const event = psp.eventFromWebhook({ event: 'settlement.processed', payload: {} });
  assert.equal(event.type, 'settlement.processed');
  assert.equal(event.orderId, null);
});

test('a fetched payment maps to an event only once it is resolved', () => {
  assert.equal(psp.eventFromPayment({ id: 'p', status: 'created' }), null);
  assert.equal(psp.eventFromPayment({ id: 'p', status: 'authorized' }), null);
  assert.equal(psp.eventFromPayment(null), null);
  assert.equal(psp.eventFromPayment({ id: 'p', status: 'captured', method: 'card' }).type, 'payment.captured');
  assert.equal(psp.eventFromPayment({ id: 'p', status: 'failed', error_description: 'no' }).type, 'payment.failed');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../routes/psp'`

- [ ] **Step 3: Write the implementation**

Create `routes/psp.js`:

```js
// Razorpay's REST API and nothing else: no database, no Express, no domain
// rules. Credentials are read per call rather than captured at require time so
// tests can set them and so a missing key is a clear 501 rather than a crash
// at boot.

const crypto = require('node:crypto');

const API = 'https://api.razorpay.com/v1';

function keyId() {
  return process.env.RAZORPAY_KEY_ID;
}

function configured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function authHeader() {
  const pair = `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`;
  return 'Basic ' + Buffer.from(pair).toString('base64');
}

async function call(path, init) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json', ...(init && init.headers) },
  });
  const text = await res.text();
  if (!res.ok) {
    // Truncated: Razorpay error bodies can be long and this goes to logs.
    throw new Error(`Razorpay ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

// amountCents is already paise, which is exactly what Razorpay's `amount`
// wants. No conversion -- multiplying here is a 100x overcharge.
function createOrder({ amountCents, receipt, notes }) {
  return call('/orders', {
    method: 'POST',
    body: JSON.stringify({ amount: amountCents, currency: 'INR', receipt, notes }),
  });
}

function fetchOrderPayments(orderId) {
  return call(`/orders/${encodeURIComponent(orderId)}/payments`, { method: 'GET' });
}

// Razorpay signs the raw bytes. Once express.json() has parsed and discarded
// them, re-serializing produces different bytes and every check here fails --
// which is why the webhook route is mounted with express.raw() ahead of the
// global parser in server.js.
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  // timingSafeEqual throws on a length mismatch, so screen for it first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function eventFromWebhook(body) {
  const type = (body && body.event) || null;
  const entity = body && body.payload && body.payload.payment && body.payload.payment.entity;
  if (!entity) return { type, orderId: null, paymentId: null, method: null, reason: null };
  return {
    type,
    orderId: entity.order_id || null,
    paymentId: entity.id || null,
    method: entity.method || null,
    reason: entity.error_description || null,
  };
}

// Used by the reconcile path, which asks Razorpay directly rather than waiting
// on a webhook. 'created' and 'authorized' are not outcomes yet, so they map
// to null and the row stays reconciling.
function eventFromPayment(payment) {
  if (!payment) return null;
  if (payment.status === 'captured') {
    return { type: 'payment.captured', paymentId: payment.id, method: payment.method || null, reason: null };
  }
  if (payment.status === 'failed') {
    return {
      type: 'payment.failed',
      paymentId: payment.id,
      method: payment.method || null,
      reason: payment.error_description || null,
    };
  }
  return null;
}

module.exports = {
  configured, keyId, createOrder, fetchOrderPayments,
  verifyWebhookSignature, eventFromWebhook, eventFromPayment,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add routes/psp.js test/psp.test.js
git commit -m "Talk to Razorpay without trusting the caller"
```

---

### Task 4: Payment routes and the trust boundary

**Files:**
- Modify: `routes/payments.js` (full rewrite of the router; `confirm` removed)
- Modify: `server.js:11-16` (webhook mounted with raw body ahead of `express.json()`)

**Interfaces:**
- Consumes: `applyPaymentEvent` from `routes/payment-events.js`; all of `routes/psp.js`.
- Produces:
  - `module.exports` — the Express router, mounted at `/api/payments`
  - `module.exports.webhook` — a standalone Express handler for `server.js` to mount with `express.raw()`
  - `POST /api/payments/order` body `{ applicationId }` or `{ challanId }` → `{ payment, keyId, orderId, amountCents, reused? }`
  - `GET /api/payments/:id` → `{ payment }`
  - `POST /api/payments/:id/dismissed` → `{ payment }`

- [ ] **Step 1: Rewrite the router**

Replace the entire contents of `routes/payments.js`:

```js
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

  const updated = await pool.query(
    `UPDATE payments
        SET status = $2,
            psp_payment_id = COALESCE($3, psp_payment_id),
            method = COALESCE($4, method),
            bank_ref = COALESCE($3, bank_ref),
            confirmed_at = CASE WHEN $2 = 'paid' THEN now() ELSE confirmed_at END
      WHERE id = $1 AND status = $5
      RETURNING *`,
    [payment.id, change.status, change.psp_payment_id, change.method, payment.status]
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
```

- [ ] **Step 2: Mount the webhook ahead of the JSON parser**

In `server.js`, replace lines 15-16:

```js
const app = express();
app.use(express.json());
```

with:

```js
const app = express();

// Razorpay signs the raw request bytes. express.json() would parse and discard
// them, and re-serializing produces different bytes, so every signature check
// would fail. This mount has to come first.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), paymentRoutes.webhook);

app.use(express.json());
```

- [ ] **Step 3: Verify syntax and that the suite still passes**

Run:

```bash
node --check routes/payments.js && node --check server.js && npm test
```

Expected: no syntax errors; all tests pass (the pure suites are unaffected).

- [ ] **Step 4: Verify the webhook rejects an unsigned request**

Start the server (`npm start`), then:

```bash
curl -s -o /dev/null -w "unsigned: HTTP %{http_code}\n" -X POST \
  http://127.0.0.1:3000/api/payments/webhook \
  -H 'Content-Type: application/json' -d '{"event":"payment.captured"}'
```

Expected: `unsigned: HTTP 400`. If this returns 200, the signature check is not running and the trust boundary is open.

- [ ] **Step 5: Verify a correctly signed unknown-order webhook is acknowledged**

```bash
node -e '
const crypto=require("crypto");require("dotenv").config();
const raw=JSON.stringify({event:"payment.captured",payload:{payment:{entity:{id:"pay_X",order_id:"order_NOPE",method:"upi"}}}});
const sig=crypto.createHmac("sha256",process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
fetch("http://127.0.0.1:3000/api/payments/webhook",{method:"POST",headers:{"Content-Type":"application/json","x-razorpay-signature":sig},body:raw})
 .then(r=>r.text()).then(t=>console.log("signed:",t));'
```

Expected: `signed: {"ok":true,"ignored":"unknown order"}`. This proves raw-body verification works end to end without touching a real payment.

- [ ] **Step 6: Commit**

```bash
git add routes/payments.js server.js
git commit -m "Let only a signed webhook say a payment succeeded"
```

---

### Task 5: The checkout popup

**Files:**
- Modify: `public/index.html` — add checkout script; add pay panel to `intake-panel-3` before the `intake-nav` at line 555; change that nav button; delete `screen-pay` (lines 563-600); rewrite the disclaimer at line 723
- Modify: `public/app.js` — delete `renderPayScreen` (497-508), `selectedPaymentMethod` (510-514), `processPayment` (516-536), `runPayment` (538-564); rewrite `payChallan` (827-841); replace the `goto-pay` / `pay-now` / `pay-delay-demo` arms (1455-1469)
- Modify: `public/styles.css` — pay panel styling

**Interfaces:**
- Consumes: `POST /api/payments/order`, `GET /api/payments/:id`, `POST /api/payments/:id/dismissed` from Task 4.
- Produces: `openCheckout({ applicationId, challanId, onSettled })`; `pollPayment(paymentId, onTick)` → settled payment. Keeps the `pay-challan` arm name so `test/action-contract.test.js:58-66` still passes.

- [ ] **Step 1: Add the checkout script**

In `public/index.html`, immediately before the closing `</body>`, before the existing `app.js` script tag, add:

```html
<!-- Razorpay does not permit self-hosting checkout.js; it must load from their
     domain so the popup stays current with their gateway. -->
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

- [ ] **Step 2: Add the pay panel to intake step 3**

In `public/index.html`, insert immediately before the `<div class="intake-nav">` at line 555:

```html
      <div class="pay-inline" id="intake-pay">
        <p class="pay-inline-assure">Every payment attempt is protected — you cannot be charged twice.</p>
        <div id="pay-status" hidden aria-live="polite"></div>
      </div>
```

- [ ] **Step 3: Change the nav button from a page hop to a popup**

In `public/index.html`, replace the line 557 button:

```html
        <button class="btn primary" data-action="goto-pay">Proceed to payment</button>
```

with:

```html
        <button class="btn primary pay-trigger" data-action="pay-now" id="pay-button">Pay securely</button>
```

- [ ] **Step 4: Delete the payment page and correct the disclaimer**

Delete `public/index.html` lines 562-600 inclusive — the blank line, the `<!-- PAY -->` comment, and the whole `<section class="screen" id="screen-pay">` through its `</section>`.

Then in the `<p class="foot-meta">` at line 723 (now shifted up), replace the sentence:

```
No real government official, system, OTP, or payment gateway is referenced or contacted.
```

with:

```
No real government official, system, or OTP is referenced or contacted. Fee and challan payments run against Razorpay's test-mode sandbox — the gateway is real, no money moves, and no live payment instrument is ever charged.
```

- [ ] **Step 5: Replace the client payment functions**

In `public/app.js`, delete `renderPayScreen`, `selectedPaymentMethod`, `processPayment`, and `runPayment` (lines 497-564) and put in their place:

```js
// The server decides the amount and the order; this only opens the popup and
// then watches. It cannot mark anything paid -- there is no endpoint for that.
async function openCheckout(payable, statusEl){
  var created = await api('/api/payments/order', { method:'POST', body: payable });
  if(!window.Razorpay){
    throw new Error('The payment window could not load. Check your connection and try again.');
  }

  return new Promise(function(resolve, reject){
    var settled = false;
    var rzp = new window.Razorpay({
      key: created.keyId,
      order_id: created.orderId,
      amount: created.amountCents,
      currency: 'INR',
      name: 'Sarathi',
      description: 'Government fee payment (test mode)',
      prefill: {
        name: session.citizen && session.citizen.name,
        contact: session.citizen && session.citizen.mobile_number,
      },
      theme: { color: '#22315c' },
      handler: function(){
        // Deliberately does not report success. The popup closing only means
        // the citizen finished with it -- the webhook says whether money moved.
        if(settled) return;
        settled = true;
        pollPayment(created.payment.id, statusEl).then(resolve, reject);
      },
      modal: {
        ondismiss: function(){
          if(settled) return;
          settled = true;
          // Frees the payable for a retry. Without this the row stays
          // reconciling behind the unique index and can never be paid again.
          api('/api/payments/' + created.payment.id + '/dismissed', { method:'POST' })
            .then(function(res){ resolve(res.payment); }, reject);
        },
      },
    });
    rzp.on('payment.failed', function(){
      if(settled) return;
      settled = true;
      pollPayment(created.payment.id, statusEl).then(resolve, reject);
    });
    rzp.open();
  });
}

// Polls until the webhook lands. The server reconciles against Razorpay itself
// once a payment has been unresolved for a few seconds, so this terminates even
// if a delivery is lost.
async function pollPayment(paymentId, statusEl){
  var started = Date.now();
  var secs = 0;
  while(Date.now() - started < 90000){
    var res = await api('/api/payments/' + paymentId);
    if(res.payment.status !== 'reconciling') return res.payment;
    if(statusEl){
      statusEl.hidden = false;
      statusEl.innerHTML = '<div class="spinner" aria-hidden="true"></div>' +
        '<p>Confirming with your bank. You will not be charged twice, and it is safe to close this and come back.</p>' +
        '<p id="pay-timer">Awaiting bank confirmation — ' + secs + 's</p>';
    }
    await new Promise(function(r){ setTimeout(r, 1500); });
    secs = Math.round((Date.now() - started) / 1000);
  }
  return (await api('/api/payments/' + paymentId)).payment;
}

async function runPayment(){
  document.querySelectorAll('.pay-trigger').forEach(function(b){ b.disabled = true; });
  var status = document.getElementById('pay-status');
  status.hidden = true;
  status.innerHTML = '';

  try{
    var payment = await openCheckout({ applicationId: session.applicationId }, status);

    if(payment.status === 'paid'){
      status.hidden = false;
      status.innerHTML = '<div class="stamp">PAYMENT<br>CONFIRMED</div>' +
        '<p class="rec-id" style="text-align:center;">Application number: ' + session.referenceCode + '</p>' +
        '<ul class="checklist payment-notifications">' +
          '<li><span class="tick">✓</span><span><strong>Email sent successfully</strong><br><span class="hint">Receipt and appointment details sent to your email address on file.</span></span></li>' +
          '<li><span class="tick">✓</span><span><strong>Mobile confirmation sent successfully</strong><br><span class="hint">SMS sent to ' + maskMobile(session.citizen.mobile_number) + '.</span></span></li>' +
        '</ul>' +
        '<button class="btn primary" data-action="goto-track">View application status</button>';
      return;
    }

    status.hidden = false;
    status.innerHTML = '<p class="error-text">This payment did not complete, so nothing was charged. You can try again.</p>';
    document.querySelectorAll('.pay-trigger').forEach(function(b){ b.disabled = false; });
  } catch(err){
    status.hidden = false;
    status.innerHTML = '<p class="error-text">' + escapeHtml(err.message) + '</p>';
    document.querySelectorAll('.pay-trigger').forEach(function(b){ b.disabled = false; });
  }
}
```

- [ ] **Step 6: Set the pay button's amount where the fee is already known**

`renderPayScreen` used to label the button, and it is gone. The fee is already
rendered at `public/app.js:302`, inside a function where the service is in
scope as the local `service` — not `session.service`. Insert immediately after
that line:

```js
  var payBtn = document.getElementById('pay-button');
  if(payBtn) payBtn.textContent = 'Pay ' + rupees(service.fee_cents) + ' securely';
```

- [ ] **Step 7: Route challan payment through the popup**

Replace `payChallan` in `public/app.js` (lines 827-841):

```js
// A challan is a payable like any other now: same popup, same webhook, same
// ledger row. The finally is what keeps a network drop from leaving a button
// stuck reading "Paying…" forever.
async function payChallan(btn){
  var original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try{
    var payment = await openCheckout({ challanId: btn.getAttribute('data-id') }, null);
    await loadAttention();
    if(payment.status !== 'paid'){
      alert('That payment did not complete, so nothing was charged. You can try again.');
    }
  } catch(err){
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
```

- [ ] **Step 8: Replace the action arms**

In `public/app.js`, delete the whole `else if(action === 'goto-pay'){ ... }` block (lines 1455-1467) and the `pay-delay-demo` arm, keeping the validation that used to gate the page hop:

```js
    else if(action === 'pay-now'){
      if(session.service.requires_slot && !session.selectedSlot){
        document.getElementById('cal-slot-summary').textContent = 'Please pick a date and time above to continue.';
        return;
      }
      var ackRow = document.getElementById('intake-road-safety');
      if(!ackRow.hidden && !document.getElementById('road-safety-check').checked){
        ackRow.classList.add('ack-missing');
        return;
      }
      await runPayment();
    }
```

- [ ] **Step 9: Style the inline pay panel**

Append to `public/styles.css`:

```css
  .pay-inline{margin-top:18px;padding-top:16px;border-top:1px solid var(--rule);}
  .pay-inline-assure{margin:0 0 12px;font-size:12.5px;font-weight:600;color:var(--ink-soft);}
  .pay-inline #pay-status{margin-top:14px;}
  .pay-inline #pay-status[hidden]{display:none !important;}
```

- [ ] **Step 10: Verify nothing references the deleted page or endpoints**

Run:

```bash
cd "C:/Users/Tarun Kesavan/sarathi"
echo "--- these must all be empty ---"
grep -n "screen-pay\|goto-pay\|pay-delay-demo\|selectedPaymentMethod\|processPayment\|renderPayScreen\|payments/.*confirm\|pm-upi\|pm-card\|pm-nb" public/index.html public/app.js
echo "--- these must all be present ---"
grep -c "openCheckout\|pollPayment\|checkout.razorpay.com" public/app.js public/index.html
npm test
```

Expected: the first grep prints nothing; the second prints non-zero counts; `npm test` passes — in particular `test/action-contract.test.js` still finds an arm for `pay-challan`.

- [ ] **Step 11: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "Pay in a popup from the summary instead of a page of our own"
```

---

### Task 6: Retire the divergent challan path

**Files:**
- Modify: `routes/challans.js` — delete `POST /:id/pay` (lines 39-54)
- Modify: `routes/attention.js` — challan query gains `payment_status` (lines 144-147); `computeAttention` challan branch (lines 35-45)
- Modify: `test/attention.test.js` — add the reconciling case

**Interfaces:**
- Consumes: nothing new.
- Produces: `computeAttention` reads `challan.payment_status`. **The `kind` stays `challan_pending`** — do not introduce a new kind, or the pinned `deepEqual` at `test/action-contract.test.js:41-44` fails.

- [ ] **Step 1: Write the failing test**

Append to `test/attention.test.js`:

```js
test('a challan with a payment in flight stops asking to be paid again', () => {
  // The challan is still 'pending' until the webhook lands, so the application
  // blocker correctly keeps blocking. What changes is that we stop handing the
  // citizen a button that would start a second payment.
  const items = computeAttention({
    citizen: citizen(),
    applications: [],
    challans: [{
      id: 7, challan_number: 'CH-2026-8841', offence: 'Signal violation',
      issued_on: '2026-08-12', amount_cents: 100000, status: 'pending',
      payment_status: 'reconciling',
    }],
    now: NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'challan_pending');
  assert.equal(items[0].severity, 'soon');
  assert.equal(items[0].action, null);
  assert.match(items[0].detail, /confirming with your bank/i);
});

test('a challan with a failed payment behind it can still be paid', () => {
  const items = computeAttention({
    citizen: citizen(),
    applications: [],
    challans: [{
      id: 7, challan_number: 'CH-2026-8841', offence: 'Signal violation',
      issued_on: '2026-08-12', amount_cents: 100000, status: 'pending',
      payment_status: 'failed',
    }],
    now: NOW,
  });
  assert.equal(items[0].severity, 'act');
  assert.equal(items[0].action.type, 'pay-challan');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the reconciling challan still returns `severity: 'act'` with an action.

- [ ] **Step 3: Update the challan branch**

In `routes/attention.js`, replace the loop at lines 35-45:

```js
  for (const challan of challans) {
    if (challan.status !== 'pending') continue;

    // A payment already in flight against this challan. The challan stays
    // pending until the webhook lands, so the application blocker keeps
    // blocking -- but offering a Pay button here would invite a second
    // payment for a fine that is already being settled.
    if (challan.payment_status === 'reconciling') {
      items.push({
        kind: 'challan_pending',
        severity: 'soon',
        title: `${rupees(challan.amount_cents)} challan pending`,
        detail: 'Payment received, confirming with your bank. This usually takes a few seconds and you do not need to pay again.',
        action: null,
        source: `challan ${challan.challan_number}`,
      });
      continue;
    }

    items.push({
      kind: 'challan_pending',
      severity: 'act',
      title: `${rupees(challan.amount_cents)} challan pending`,
      detail: `${challan.offence}, issued ${formatDate(challan.issued_on)}. This blocks a new or renewed licence.`,
      action: { label: `Pay ${rupees(challan.amount_cents)}`, type: 'pay-challan', id: challan.id },
      source: `challan ${challan.challan_number}`,
    });
  }
```

- [ ] **Step 4: Feed the router's challan query the same field applications already get**

In `routes/attention.js`, replace the challan query at lines 144-147:

```js
  const challans = await pool.query(
    `SELECT c.*,
            (SELECT p.status FROM payments p
              WHERE p.challan_id = c.id AND p.status IN ('reconciling','paid')
              LIMIT 1) AS payment_status
       FROM challans c
      WHERE c.citizen_id = $1 AND c.status = $2`,
    [id, 'pending']
  );
```

- [ ] **Step 5: Delete the challan pay endpoint**

In `routes/challans.js`, delete lines 39-54 — the comment block and the whole `router.post('/:id/pay', ...)` handler. `pendingChallan`, `BLOCKED_SERVICES`, and the `GET /citizen/:id` route all stay exactly as they are.

- [ ] **Step 6: Run the tests to verify they pass**

Run:

```bash
node --check routes/attention.js && node --check routes/challans.js && npm test
```

Expected: all pass, including the pinned kind list in `test/action-contract.test.js`.

- [ ] **Step 7: Verify no caller is left pointing at the deleted endpoint**

Run:

```bash
grep -rn "challans/.*pay" public/ routes/ test/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 8: Commit**

```bash
git add routes/challans.js routes/attention.js test/attention.test.js
git commit -m "Give challans the same payment path as everything else"
```

---

### Task 7: Deploy and verify against the live gateway

**Files:** none — this is configuration and verification.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified live flow on `https://sarathi.heytarun.com`.

> **This task touches live deployments. Stop and get the user's explicit go-ahead before running it.** It also needs the three secrets, which are in the local `.env` and must not be echoed.

- [ ] **Step 1: Confirm the suite is green on the exact tree being deployed**

Run: `npm test`
Expected: every test passes. Do not deploy on a red suite.

- [ ] **Step 2: Put the keys on the Pi**

The Pi runs `sarathi.service` from `~/sarathi`. Append the three `RAZORPAY_*` lines to `~/sarathi/.env` there, then restart:

```bash
ssh -i "$HOME/.ssh/sarathi_pi" -o BatchMode=yes tarunkesavan@pi-server \
  "cd ~/sarathi && git pull --ff-only origin main && sudo -n systemctl restart sarathi.service && sleep 4 && systemctl is-active sarathi.service && curl -s http://127.0.0.1:3001/api/health"
```

Expected: `active` then `{"ok":true}`.

- [ ] **Step 3: Put the keys on Render**

Add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` to the `setu-sarathi` service's environment in the Render dashboard. This is a manual step in the browser; Render redeploys automatically on save.

- [ ] **Step 4: Confirm the migration is applied to the shared database**

Run: `npm run db:migrate`
Expected: `Schema applied.` The Pi and Render share one Neon instance, so this runs once from anywhere.

- [ ] **Step 5: Verify the webhook endpoint is publicly reachable and rejects forgeries**

```bash
curl -s -o /dev/null -w "unsigned from the internet: HTTP %{http_code}\n" -X POST \
  https://sarathi.heytarun.com/api/payments/webhook \
  -H 'Content-Type: application/json' -d '{"event":"payment.captured"}'
```

Expected: `HTTP 400`. A 200 here means the tunnel is serving an unprotected endpoint.

- [ ] **Step 6: Pay a challan end to end in the browser**

On `https://sarathi.heytarun.com`, sign in as `9000000009` (Tarun Kesava Menon, one pending ₹1,000 challan). Tap the attention panel's Pay button, choose UPI in the popup, and enter the test VPA `success@razorpay`.

Expected: the popup closes; the attention item briefly reads "Payment received, confirming with your bank" with no button; within a few seconds the item disappears and the challan is gone.

- [ ] **Step 7: Confirm the webhook — not the browser — did it**

```bash
node -e '
require("dotenv").config();const p=require("./db/pool");
p.query("SELECT id,challan_id,application_id,status,method,psp_order_id,psp_payment_id,confirmed_at FROM payments ORDER BY id DESC LIMIT 3")
 .then(r=>{r.rows.forEach(x=>console.log(JSON.stringify(x)));process.exit(0)});'
```

Expected: the newest row has `status: paid`, a `psp_payment_id` starting `pay_`, a `method`, and a `confirmed_at`. A `psp_payment_id` proves Razorpay supplied it — the browser has no way to set that field.

- [ ] **Step 8: Verify a dismissal leaves the payable retryable**

Restore the demo challan, then start a payment and close the popup with the X instead of paying:

```bash
node -e '
require("dotenv").config();const p=require("./db/pool");
p.query("UPDATE challans SET status=$1, paid_at=NULL WHERE challan_number=$2",["pending","CH-2026-8841"])
 .then(()=>{console.log("challan restored to pending");process.exit(0)});'
```

Expected after dismissing: the attention Pay button comes back immediately, and a second attempt succeeds. This is the bug that would have stranded the citizen forever.

- [ ] **Step 9: Reset the demo fixtures for recording**

```bash
node -e '
require("dotenv").config();const p=require("./db/pool");
(async()=>{
 await p.query("UPDATE challans SET status=$1, paid_at=NULL WHERE challan_number=$2",["pending","CH-2026-8841"]);
 const r=await p.query("SELECT challan_number,status FROM challans");
 r.rows.forEach(x=>console.log(x.challan_number+" -> "+x.status));
 process.exit(0);})();'
```

Expected: `CH-2026-8841 -> pending`.

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: data model → Task 1; lifecycle and the two closed defects → Tasks 2 and 4; trust boundary → Task 4; endpoints → Task 4 (with the deleted challan endpoint in Task 6); UI → Task 5; error handling → Tasks 2, 4, 5; testing → Tasks 2, 3, 6; the disclaimer correction → Task 5 Step 4. The spec's `payments` input for `computeAttention` was corrected to a `payment_status` field before this plan was written, matching how applications already work at `routes/attention.js:135-137`.

**Placeholder scan.** No TBD, TODO, "handle edge cases", or "similar to Task N". Every code step carries the actual code; every verification step carries the actual command and its expected output.

**Type consistency.** `applyPaymentEvent({ payment, event })` returns `{ status, psp_payment_id, method, reason }` in Task 2 and is consumed with exactly those field names by `settle()` in Task 4. `psp.eventFromWebhook` and `psp.eventFromPayment` both emit `{ type, orderId, paymentId, method, reason }` in Task 3, which is the shape Task 2's `event` reads. `openCheckout({ applicationId | challanId }, statusEl)` in Task 5 posts exactly the body `resolvePayable` accepts in Task 4. The `pay-challan` action type is unchanged, so `ACTION_TYPES` and the contract test stay valid.

**One deliberate inconsistency with project convention.** `checkout.js` loads from Razorpay's CDN rather than being vendored. Razorpay does not permit self-hosting it. This is called out in Task 5 Step 1 so it is not mistaken for an oversight.
