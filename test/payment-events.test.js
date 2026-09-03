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

test('an abandoned attempt is released so the payable can be paid again', () => {
  // A citizen who closes the browser mid-popup fires no dismissal. Without this
  // the row holds the live-payment unique index forever, and for a challan that
  // also blocks their licence forever.
  const change = applyPaymentEvent({
    payment: { id: 1, status: 'reconciling' },
    event: { type: 'client.abandoned' },
  });
  assert.equal(change.status, 'failed');
  assert.match(change.reason, /timed out/);
});

test('an abandoned event cannot undo a captured payment', () => {
  assert.equal(
    applyPaymentEvent({ payment: { id: 1, status: 'paid' }, event: { type: 'client.abandoned' } }),
    null
  );
});

test('an unknown method is passed through rather than dropped', () => {
  assert.equal(methodLabel('upi'), 'UPI');
  assert.equal(methodLabel('netbanking'), 'Net banking');
  assert.equal(methodLabel('paylater'), 'paylater');
  assert.equal(methodLabel(null), null);
});
