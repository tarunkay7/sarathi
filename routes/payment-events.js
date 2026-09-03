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
