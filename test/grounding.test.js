// The grounding guard decides whether an answer reaches the citizen at all, so
// it is the most consequential logic on this feature — and it is pure: set
// membership over two row arrays plus the string the model claimed. Nothing
// here touches the database. DATABASE_URL points at the live instance both
// deployments serve from.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isGrounded } = require('../routes/grievances');

// The same shapes the route feeds it: application rows carry reference_code,
// service rows carry title, key and form_number.
const APPLICATIONS = [
  { reference_code: 'TS-DL-2026-1200' },
  { reference_code: 'TS-DL-2026-3170' },
];

const SERVICES = [
  { key: 'renew', title: 'Driving Licence Renewal', form_number: 'Form 9' },
  { key: 'new', title: "New Learner's Licence", form_number: 'Form 2' },
  { key: 'dl', title: 'Permanent Driving Licence', form_number: 'Form 4' },
];

test('"none" is not a source', () => {
  assert.equal(isGrounded('none', APPLICATIONS, SERVICES), false);
  assert.equal(isGrounded('None', APPLICATIONS, SERVICES), false);
});

test('an empty or missing source is not a source', () => {
  assert.equal(isGrounded('', APPLICATIONS, SERVICES), false);
  assert.equal(isGrounded('   ', APPLICATIONS, SERVICES), false);
  assert.equal(isGrounded(undefined, APPLICATIONS, SERVICES), false);
  assert.equal(isGrounded(null, APPLICATIONS, SERVICES), false);
});

test('an invented reference code is rejected', () => {
  assert.equal(isGrounded('TS-DL-2026-9999', APPLICATIONS, SERVICES), false);
});

test('a vague phrase is rejected even though it sounds like a citation', () => {
  assert.equal(isGrounded('your application record', APPLICATIONS, SERVICES), false);
  assert.equal(isGrounded('RTO records', APPLICATIONS, SERVICES), false);
});

test('a real reference code from the citizen own rows is accepted', () => {
  assert.equal(isGrounded('TS-DL-2026-1200', APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded('TS-DL-2026-3170', APPLICATIONS, SERVICES), true);
});

test('a service title, key or form number is accepted', () => {
  assert.equal(isGrounded('Driving Licence Renewal', APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded('renew', APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded('Form 9', APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded("New Learner's Licence", APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded('Form 4', APPLICATIONS, SERVICES), true);
});

test('case and surrounding whitespace do not decide whether an answer is delivered', () => {
  assert.equal(isGrounded('ts-dl-2026-1200', APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded('  TS-DL-2026-1200  ', APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded('FORM 9', APPLICATIONS, SERVICES), true);
  assert.equal(isGrounded('\tdriving licence renewal\n', APPLICATIONS, SERVICES), true);
});

// The known false negative, asserted rather than left to chance. Matching is
// exact, so a model that writes the code inside a phrase is treated as
// ungrounded and its question goes to a human. Accepting the phrase would mean
// substring matching, and the service keys are the words 'new', 'dl' and
// 'renew' — under substring matching almost any sentence mentioning a renewal
// would pass. Failing towards an unanswered question is the recoverable
// direction; failing towards a laundered citation is not.
test('a code wrapped in a phrase is deliberately rejected, not leniently accepted', () => {
  assert.equal(isGrounded('application TS-DL-2026-1200', APPLICATIONS, SERVICES), false);
  assert.equal(isGrounded('your TS-DL-2026-1200 renewal', APPLICATIONS, SERVICES), false);
});

test('a sentence that merely contains a service key does not pass as a citation', () => {
  assert.equal(isGrounded('the new rules for renewal', APPLICATIONS, SERVICES), false);
  assert.equal(isGrounded('dl records', APPLICATIONS, SERVICES), false);
});

test('a citizen with no applications can still be grounded in a service rule', () => {
  assert.equal(isGrounded('Form 2', [], SERVICES), true);
  assert.equal(isGrounded('TS-DL-2026-1200', [], SERVICES), false);
});

test('with nothing to cite, nothing is grounded', () => {
  assert.equal(isGrounded('TS-DL-2026-1200', [], []), false);
  assert.equal(isGrounded('Form 9', [], []), false);
});
