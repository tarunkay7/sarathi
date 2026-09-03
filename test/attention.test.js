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
  assert.equal(items[0].source, 'challan CH-2026-8841');
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

test('an application past its expected date is act-now', () => {
  const items = computeAttention({
    citizen: citizen(), applications: [application({ expected_by: '2026-08-20' })],
    challans: [], now: NOW,
  });
  const item = items.find((i) => i.kind === 'overdue');
  assert.equal(item.severity, 'act');
  assert.equal(item.source, 'application TS-DL-2026-3170');
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
