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

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

module.exports = { computeAttention };
