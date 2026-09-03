// The contract neither file could see on its own. The attention engine puts an
// action.type on a button; the browser's handleAction has to have an arm for
// it. They live in different files, so the engine grew action types the click
// handler never learned and four of five attention buttons shipped doing
// nothing at all — including "Pay now" on an incomplete payment, this project's
// own headline problem. Nothing here touches the database: one test reads the
// pure engine, the other reads the client file as text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computeAttention, ACTION_TYPES } = require('../routes/attention');

const NOW = new Date('2026-09-03T00:00:00Z');

// A citizen in every state at once, so every branch that can attach a button
// does. If a future kind arrives without being added here, the deepEqual below
// is what notices.
function everyKind() {
  return computeAttention({
    citizen: { id: 1, name: 'Test Citizen', dl_expires_on: '2026-09-27' },
    applications: [
      { id: 10, reference_code: 'TS-DL-2026-3170', fee_cents: 70000, payment_status: null, expected_by: '2026-09-20', slot_at: null },
      { id: 11, reference_code: 'TS-DL-2026-3171', fee_cents: 70000, payment_status: 'paid', expected_by: '2026-08-20', slot_at: null },
      { id: 12, reference_code: 'TS-DL-2026-3172', fee_cents: 70000, payment_status: 'paid', expected_by: '2026-09-20', slot_at: '2026-09-05T10:00:00Z', carry_items: 'Acknowledgement slip' },
    ],
    challans: [{
      id: 7, challan_number: 'CH-2026-8841', offence: 'Signal violation',
      issued_on: '2026-08-12', amount_cents: 100000, status: 'pending',
    }],
    now: NOW,
  });
}

test('the declared action types are exactly the ones the engine can emit', () => {
  const items = everyKind();
  // Pinned so a new kind cannot be added without this fixture being extended to
  // cover it. licence_expired is the one kind absent, because a licence cannot
  // be expiring and expired at once; it is checked separately below.
  assert.deepEqual(
    [...new Set(items.map((i) => i.kind))].sort(),
    ['appointment_soon', 'challan_pending', 'licence_expiring', 'overdue', 'payment_incomplete']
  );
  const emitted = [...new Set(items.filter((i) => i.action).map((i) => i.action.type))].sort();
  assert.deepEqual(emitted, [...ACTION_TYPES].sort());
});

test('an expired licence emits a declared action type too', () => {
  const items = computeAttention({
    citizen: { id: 1, name: 'Test Citizen', dl_expires_on: '2026-07-01' },
    applications: [], challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'licence_expired');
  assert.ok(ACTION_TYPES.includes(item.action.type));
});

test('every declared action type has an arm in the browser click handler', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const type of ACTION_TYPES) {
    assert.ok(
      clientSource.includes(`action === '${type}'`),
      `public/app.js handleAction has no arm for '${type}', so that attention button does nothing when clicked`
    );
  }
});
