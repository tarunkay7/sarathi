const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAttention } = require('../routes/attention');

const NOW = new Date('2026-09-03T00:00:00Z');

function citizen(over = {}) {
  return { id: 1, name: 'Test Citizen', dl_expires_on: null, ...over };
}

test('a citizen with nothing outstanding gets an empty list', () => {
  const items = computeAttention({
    citizen: citizen(), applications: [], challans: [], now: NOW,
  });
  assert.deepEqual(items, []);
});

test('a pending challan is an act-now item naming the challan', () => {
  const items = computeAttention({
    citizen: citizen(),
    applications: [],
    challans: [{
      id: 7, challan_number: 'CH-2026-8841', offence: 'Signal violation',
      issued_on: '2026-08-12', amount_cents: 100000, status: 'pending',
    }],
    now: NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'challan_pending');
  assert.equal(items[0].severity, 'act');
  assert.match(items[0].title, /₹1,000/);
  assert.match(items[0].detail, /issued 12 Aug 2026/);
  assert.equal(items[0].source, 'challan CH-2026-8841');
});

// node-pg returns DATE columns as JS Date objects, not strings — the string
// fixture above never exercises that path. Without this, a formatter that
// only handled strings would pass every test while printing a raw
// "Wed Aug 12 2026 00:00:00 GMT+0530 (India Standard Time)" against the live
// database.
test('a pending challan issued as a Date object still reads as a plain date', () => {
  const items = computeAttention({
    citizen: citizen(),
    applications: [],
    challans: [{
      id: 7, challan_number: 'CH-2026-8841', offence: 'Signal violation',
      issued_on: new Date('2026-08-12'), amount_cents: 100000, status: 'pending',
    }],
    now: NOW,
  });
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /issued 12 Aug 2026/);
  assert.doesNotMatch(items[0].detail, /GMT/);
});

test('a paid challan produces nothing', () => {
  const items = computeAttention({
    citizen: citizen(),
    applications: [],
    challans: [{
      id: 7, challan_number: 'CH-2026-8841', offence: 'Signal violation',
      issued_on: '2026-08-12', amount_cents: 100000, status: 'paid',
    }],
    now: NOW,
  });
  assert.deepEqual(items, []);
});

test('a citizen with no licence gets no expiry item and does not throw', () => {
  const items = computeAttention({
    citizen: citizen({ dl_expires_on: null }), applications: [], challans: [], now: NOW,
  });
  assert.equal(items.filter((i) => i.kind.startsWith('licence_')).length, 0);
});

function application(over = {}) {
  return {
    id: 10, reference_code: 'TS-DL-2026-3170', service_title: 'Permanent Driving Licence',
    fee_cents: 70000, expected_by: '2026-09-20', slot_at: null,
    carry_items: 'Acknowledgement slip', payment_status: 'paid', ...over,
  };
}

test('an application with no live payment is act-now', () => {
  const items = computeAttention({
    citizen: citizen(), applications: [application({ payment_status: null })],
    challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'payment_incomplete');
  assert.equal(item.severity, 'act');
  assert.match(item.detail, /TS-DL-2026-3170/);
  assert.match(item.detail, /₹700/);
});

// The trigger is a missing payment row, which is not evidence that a payment
// failed. Saying it failed is the exact false alarm this project exists to fix,
// so the wording is asserted, not left to a reviewer to notice.
test('an unpaid application is described as not paid, not as a failed payment', () => {
  const items = computeAttention({
    citizen: citizen(), applications: [application({ payment_status: null })],
    challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'payment_incomplete');
  assert.equal(item.title, 'Your payment is not complete');
  assert.match(item.detail, /has not been paid yet/);
  assert.doesNotMatch(item.title, /did not complete/);
});

test('an application past its expected date is act-now', () => {
  const items = computeAttention({
    citizen: citizen(), applications: [application({ expected_by: '2026-08-20' })],
    challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'overdue');
  assert.equal(item.severity, 'act');
  assert.equal(item.source, 'application TS-DL-2026-3170');
});

// Escalation is a separate act with its own column and no scheduler behind it.
// This item fires on the date alone, so it may only claim an escalation when
// the row records one.
test('an overdue application that was escalated says so', () => {
  const items = computeAttention({
    citizen: citizen(),
    applications: [application({ expected_by: '2026-08-20', escalated: true })],
    challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'overdue');
  assert.match(item.detail, /was escalated for you/);
});

test('an overdue application that was never escalated does not claim it was', () => {
  const items = computeAttention({
    citizen: citizen(),
    applications: [application({ expected_by: '2026-08-20', escalated: false })],
    challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'overdue');
  assert.doesNotMatch(item.detail, /escalat/i);
  assert.equal(item.detail, 'TS-DL-2026-3170 has passed its expected date and is still open.');
});

test('a licence expiring inside 60 days is soon, and says how many days', () => {
  const items = computeAttention({
    citizen: citizen({ dl_expires_on: '2026-09-27' }), applications: [], challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'licence_expiring');
  assert.equal(item.severity, 'soon');
  assert.match(item.title, /24 days/);
});

test('a licence more than 60 days out produces nothing', () => {
  const items = computeAttention({
    citizen: citizen({ dl_expires_on: '2027-06-01' }), applications: [], challans: [], now: NOW,
  });
  assert.deepEqual(items, []);
});

test('an already expired licence is act-now, not soon', () => {
  const items = computeAttention({
    citizen: citizen({ dl_expires_on: '2026-07-01' }), applications: [], challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'licence_expired');
  assert.equal(item.severity, 'act');
});

test('an appointment inside 3 days is soon and names what to carry', () => {
  const items = computeAttention({
    citizen: citizen(),
    applications: [application({ slot_at: '2026-09-05T10:00:00Z', carry_items: 'Your learner\'s licence' })],
    challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'appointment_soon');
  assert.equal(item.severity, 'soon');
  assert.match(item.detail, /learner/);
});

test('act items sort above soon items', () => {
  const items = computeAttention({
    citizen: citizen({ dl_expires_on: '2026-09-27' }),
    applications: [application({ payment_status: null })],
    challans: [], now: NOW,
  });
  assert.equal(items[0].severity, 'act');
  assert.equal(items[items.length - 1].severity, 'soon');
});

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
