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
