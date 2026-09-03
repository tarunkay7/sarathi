// Computed, never stored. An attention list built from rows that already exist
// cannot go stale, and cannot claim anything the database does not hold.
//
// computeAttention is pure and takes its own clock so it can be tested without
// a database — DATABASE_URL points at the live instance both deployments serve
// from, so no test may go near it.

function rupees(cents) {
  return '₹' + Math.round(cents / 100).toLocaleString('en-IN');
}

const SEVERITY_ORDER = { act: 0, soon: 1, info: 2 };

function computeAttention({ citizen, applications = [], challans = [], now = new Date() }) {
  const items = [];

  for (const challan of challans) {
    if (challan.status !== 'pending') continue;
    items.push({
      kind: 'challan_pending',
      severity: 'act',
      title: `${rupees(challan.amount_cents)} challan pending`,
      detail: `${challan.offence}, issued ${challan.issued_on}. This blocks a new or renewed licence.`,
      action: { label: `Pay ${rupees(challan.amount_cents)}`, type: 'pay-challan', id: challan.id },
      source: `challan ${challan.challan_number}`,
    });
  }

  const DAY = 24 * 60 * 60 * 1000;
  const days = (iso) => Math.round((new Date(iso).getTime() - now.getTime()) / DAY);

  if (citizen.dl_expires_on) {
    const left = days(citizen.dl_expires_on);
    if (left < 0) {
      items.push({
        kind: 'licence_expired',
        severity: 'act',
        title: `Your licence expired ${Math.abs(left)} days ago`,
        detail: 'You can still renew — the window stays open for a year after expiry.',
        action: { label: 'Renew now', type: 'start-renew' },
        source: 'renewal window rule',
      });
    } else if (left <= 60) {
      items.push({
        kind: 'licence_expiring',
        severity: 'soon',
        title: `Your licence expires in ${left} days`,
        detail: 'Renew now and it stays valid with no gap.',
        action: { label: 'Renew now', type: 'start-renew' },
        source: 'renewal window rule',
      });
    }
  }

  for (const app of applications) {
    if (!app.payment_status) {
      items.push({
        kind: 'payment_incomplete',
        severity: 'act',
        title: 'Your payment did not complete',
        detail: `${app.reference_code} is waiting on ${rupees(app.fee_cents)}.`,
        action: { label: 'Pay now', type: 'open-application', id: app.id },
        source: `application ${app.reference_code}`,
      });
    }
    if (app.expected_by && days(app.expected_by) < 0) {
      items.push({
        kind: 'overdue',
        severity: 'act',
        title: 'An application is running late',
        detail: `${app.reference_code} has passed its expected date and was escalated for you.`,
        action: { label: 'View status', type: 'open-application', id: app.id },
        source: `application ${app.reference_code}`,
      });
    }
    if (app.slot_at) {
      const until = days(app.slot_at);
      if (until >= 0 && until <= 3) {
        items.push({
          kind: 'appointment_soon',
          severity: 'soon',
          title: until === 0 ? 'Your RTO appointment is today' : `Your RTO appointment is in ${until} days`,
          detail: `Carry: ${app.carry_items || 'your acknowledgement slip'}.`,
          action: { label: 'View appointment', type: 'open-application', id: app.id },
          source: `application ${app.reference_code}`,
        });
      }
    }
  }

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

module.exports = { computeAttention };
