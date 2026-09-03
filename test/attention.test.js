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
