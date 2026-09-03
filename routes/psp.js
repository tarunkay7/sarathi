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
