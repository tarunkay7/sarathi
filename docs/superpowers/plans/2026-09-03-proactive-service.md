# Proactive Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sarathi tell citizens what needs doing before they have to ask — a computed attention surface, a pending-challan blocker on licence applications, and grievance answers grounded in rules the app already stores.

**Architecture:** One new pure module (`routes/attention.js`) computes an attention list from rows already in the database; it is exported separately from its Express route so it can be unit-tested without a database. A `challans` table adds a blocker enforced inside `POST /api/applications`, cleared by a guarded status update. The grievance fact sheet gains the `services` table so the model can cite a source instead of inventing one.

**Tech Stack:** Node 20+ (Pi runs 20.20.2, dev runs 24.13.1), Express 4, Postgres via `pg`, `node:test` built-in test runner — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-proactive-service-design.md`

## Global Constraints

- **No new npm dependencies.** Tests use `node:test` and `node:assert/strict`, both built in.
- **Tests must not touch the database.** `DATABASE_URL` points at the live Neon instance that both Render and the Pi serve from. Every test in this plan runs against plain objects.
- **Server-side enforcement.** Any rule a citizen could bypass goes in the route, not the client — matching the existing server-derived fee and required vehicle class.
- **Nothing hardcoded into the attention panel.** Every item must derive from a real row or a real rule. A hardcoded item makes the `Because:` line a lie.
- **British-influenced Indian English in UI copy**, matching existing strings: "licence" not "license", "₹" prefixed with no space.
- **Existing components only:** `.panel`, `.panel-head`, `.panel-head-main`, `.sub`, `.btn`, `.hint`. Colours from the `:root` palette in `public/styles.css` — `#A3402E` act, `#D98A2B` soon, `#22315C` info.
- **Disclosure is not optional.** Nothing is actually sent; the panel says so.

---

### Task 1: Test runner and the attention engine's pure core

**Files:**
- Modify: `package.json` (add `test` script)
- Create: `routes/attention.js`
- Test: `test/attention.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeAttention({ citizen, applications, challans, now })` returning an array of items, each `{ kind, severity, title, detail, action, source }`. `severity` is one of `'act' | 'soon' | 'info'`. `action` is `{ label, type }` or `null`. Exported from `routes/attention.js` as a named export alongside the router added in Task 3.

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "node --test test/"
```

- [ ] **Step 2: Write the failing test**

Create `test/attention.test.js`:

```js
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
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../routes/attention'`

- [ ] **Step 4: Write the minimal implementation**

Create `routes/attention.js`:

```js
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
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json routes/attention.js test/attention.test.js
git commit -m "Compute an attention list from rows the system already holds"
```

---

### Task 2: The remaining attention checks

**Files:**
- Modify: `routes/attention.js`
- Test: `test/attention.test.js`

**Interfaces:**
- Consumes: `computeAttention` from Task 1.
- Produces: the same function, now emitting kinds `payment_incomplete`, `overdue`, `licence_expired`, `licence_expiring`, `appointment_soon`. Application rows are expected to carry `reference_code`, `service_title`, `fee_cents`, `expected_by`, `slot_at`, `carry_items`, and `payment_status` (`null` when no live payment exists).

- [ ] **Step 1: Write the failing tests**

Append to `test/attention.test.js`:

```js
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
    applications: [application({ slot_at: '2026-09-05T10:00:00Z', carry_items: 'Your learner’s licence' })],
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — the new kinds are not emitted yet.

- [ ] **Step 3: Implement the checks**

In `routes/attention.js`, replace the body of `computeAttention` between the challan loop and the `return`:

```js
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
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add routes/attention.js test/attention.test.js
git commit -m "Add the remaining attention checks"
```

---

### Task 3: The challans table, seed data, and the licence expiry column

**Files:**
- Modify: `db/schema.sql` (append)
- Modify: `db/seed.js` (append a challan seed block before `await pool.end()`)

**Interfaces:**
- Consumes: nothing.
- Produces: table `challans` and column `citizens.dl_expires_on`, both used by Tasks 4 and 5.

- [ ] **Step 1: Append the schema**

Add to the end of `db/schema.sql`:

```sql
-- A licence has an expiry, and a proactive service is built around it. The
-- dashboard was showing a hardcoded date, which is the one number this whole
-- feature depends on. Nullable: an account that holds no licence has no expiry.
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS dl_expires_on DATE;

-- Seeded, not fetched. A real deployment would read these from e-Challan or
-- VAHAN; this prototype stores them so the blocker has something real to point
-- at rather than the model inventing a fine.
CREATE TABLE IF NOT EXISTS challans (
  id SERIAL PRIMARY KEY,
  challan_number TEXT UNIQUE NOT NULL,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  offence TEXT NOT NULL,
  location TEXT,
  issued_on DATE NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid')),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS challans_citizen_idx ON challans (citizen_id, status);
```

- [ ] **Step 2: Run the migration**

Run: `npm run db:migrate`
Expected: `Schema applied.`

- [ ] **Step 3: Seed a challan for the demo persona**

In `db/seed.js`, immediately before `await pool.end();`, add:

```js
  // The demo persona applies for a permanent licence, so the challan has to
  // block that rather than a renewal. Attached by mobile number because ids
  // differ between the local and deployed databases.
  const demo = await pool.query(
    'SELECT id FROM citizens WHERE mobile_number = $1',
    ['9000000009']
  );
  if (demo.rows[0]) {
    await pool.query(
      `INSERT INTO challans (challan_number, citizen_id, offence, location, issued_on, amount_cents, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       ON CONFLICT (challan_number) DO NOTHING`,
      ['CH-2026-8841', demo.rows[0].id, 'Signal violation', 'Uppal X Roads, Hyderabad', '2026-08-12', 100000]
    );
    console.log('Seeded 1 pending challan for the demo account.');
  }
```

- [ ] **Step 4: Run the seed and confirm**

Run: `npm run db:seed`
Expected: `Seeded 4 services.` then `Seeded 1 pending challan for the demo account.`

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql db/seed.js
git commit -m "Add challans and a real licence expiry"
```

---

### Task 4: The challan blocker and the pay endpoint

**Files:**
- Create: `routes/challans.js`
- Modify: `server.js:11` (require) and `server.js:27` (mount)
- Modify: `routes/applications.js:108-111` (add the blocker after the vehicle-class check)

**Interfaces:**
- Consumes: the `challans` table from Task 3.
- Produces: `GET /api/challans/citizen/:id` → `{ challans: [...] }`; `POST /api/challans/:id/pay` → `{ challan }`. `POST /api/applications` now returns 409 with `{ error }` when a pending challan blocks `renew` or `dl`.

- [ ] **Step 1: Write the route**

Create `routes/challans.js`:

```js
const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

// Issuing or extending a licence is blocked by an unpaid fine; replacing a lost
// document or taking a first learner's test is not. Exported so the application
// route enforces exactly the same rule rather than a second copy of it.
const BLOCKED_SERVICES = ['renew', 'dl'];

function requireInteger(value, res) {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return Number(value);
}

async function pendingChallan(citizenId) {
  const result = await pool.query(
    `SELECT * FROM challans WHERE citizen_id = $1 AND status = 'pending'
     ORDER BY issued_on LIMIT 1`,
    [citizenId]
  );
  return result.rows[0] || null;
}

router.get('/citizen/:id', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const result = await pool.query(
    'SELECT * FROM challans WHERE citizen_id = $1 ORDER BY issued_on DESC',
    [id]
  );
  res.json({ challans: result.rows });
}));

// Not a row in payments: that table requires an application_id and a challan has
// none. The status guard makes this idempotent — a second call matches nothing.
router.post('/:id/pay', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const settled = await pool.query(
    `UPDATE challans SET status = 'paid', paid_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id]
  );
  if (settled.rows[0]) return res.json({ challan: settled.rows[0] });

  const existing = await pool.query('SELECT * FROM challans WHERE id = $1', [id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ challan: existing.rows[0], alreadyPaid: true });
}));

module.exports = router;
module.exports.pendingChallan = pendingChallan;
module.exports.BLOCKED_SERVICES = BLOCKED_SERVICES;
```

- [ ] **Step 2: Mount it**

In `server.js`, after line 11 add:

```js
const challanRoutes = require('./routes/challans');
```

and after line 27 add:

```js
app.use('/api/challans', challanRoutes);
```

- [ ] **Step 3: Enforce the block**

In `routes/applications.js`, add near the other requires at the top:

```js
const { pendingChallan, BLOCKED_SERVICES } = require('./challans');
```

Then immediately after the vehicle-class check that ends at line 111, insert:

```js
  // Surfaced on the dashboard long before this point; enforced here so it cannot
  // be skipped by a client that simply does not render the warning.
  if (BLOCKED_SERVICES.includes(serviceKey)) {
    const challan = await pendingChallan(citizenId);
    if (challan) {
      return res.status(409).json({
        error: `Challan ${challan.challan_number} for ₹${Math.round(challan.amount_cents / 100)} is still pending. Clear it and this application can go ahead.`,
      });
    }
  }
```

- [ ] **Step 4: Verify by hand against the running server**

Run in one shell: `node server.js`
Then:

```bash
CID=$(curl -s -X POST http://localhost:3000/api/auth/verify-otp -H 'Content-Type: application/json' \
  -d '{"mobile":"9000000009","otp":"123456"}' | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
# blocked
curl -s -X POST http://localhost:3000/api/applications -H 'Content-Type: application/json' \
  -d "{\"citizenId\":$CID,\"serviceKey\":\"dl\",\"learnerLicenceNumber\":\"LL2025001234\",\"vehicleClasses\":\"LMV\"}"
# not blocked
curl -s -X POST http://localhost:3000/api/applications -H 'Content-Type: application/json' \
  -d "{\"citizenId\":$CID,\"serviceKey\":\"duplicate\"}"
```

Expected: the first returns the challan error; the second succeeds.

- [ ] **Step 5: Verify paying clears it, twice over**

```bash
CH=$(curl -s http://localhost:3000/api/challans/citizen/$CID | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
curl -s -X POST http://localhost:3000/api/challans/$CH/pay
curl -s -X POST http://localhost:3000/api/challans/$CH/pay
curl -s -X POST http://localhost:3000/api/applications -H 'Content-Type: application/json' \
  -d "{\"citizenId\":$CID,\"serviceKey\":\"dl\",\"learnerLicenceNumber\":\"LL2025001234\",\"vehicleClasses\":\"LMV\"}"
```

Expected: first pay returns the challan as `paid`; second returns `alreadyPaid: true` and does not error; the application now succeeds.

- [ ] **Step 6: Reset the demo account and commit**

```bash
npm run db:seed
git add routes/challans.js server.js routes/applications.js
git commit -m "Block a licence application while a challan is pending"
```

---

### Task 5: The attention route

**Files:**
- Modify: `routes/attention.js` (add the router below the pure function)
- Modify: `server.js` (require and mount)

**Interfaces:**
- Consumes: `computeAttention` from Tasks 1–2; the `challans` table from Task 3.
- Produces: `GET /api/attention/citizen/:id` → `{ items: [...] }` in severity order.

- [ ] **Step 1: Add the router**

At the top of `routes/attention.js` add:

```js
const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();
```

At the bottom, replace `module.exports = { computeAttention };` with:

```js
router.get('/citizen/:id', asyncHandler(async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const id = Number(req.params.id);

  const citizenResult = await pool.query('SELECT * FROM citizens WHERE id = $1', [id]);
  const citizen = citizenResult.rows[0];
  if (!citizen) return res.status(404).json({ error: 'Not found' });

  const applications = await pool.query(
    `SELECT a.id, a.reference_code, a.expected_by, a.slot_at,
            s.title AS service_title, s.fee_cents, s.carry_items,
            (SELECT p.status FROM payments p
              WHERE p.application_id = a.id AND p.status IN ('reconciling','paid')
              LIMIT 1) AS payment_status
     FROM applications a
     JOIN services s ON s.key = a.service_key
     WHERE a.citizen_id = $1 AND a.status <> 'approved'`,
    [id]
  );

  const challans = await pool.query(
    'SELECT * FROM challans WHERE citizen_id = $1 AND status = $2',
    [id, 'pending']
  );

  res.json({
    items: computeAttention({
      citizen,
      applications: applications.rows,
      challans: challans.rows,
      now: new Date(),
    }),
  });
}));

module.exports = router;
module.exports.computeAttention = computeAttention;
```

- [ ] **Step 2: Fix the test's import**

In `test/attention.test.js`, change the first require to:

```js
const { computeAttention } = require('../routes/attention');
```

(unchanged in form — confirm it still resolves now that the module exports a router as well).

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS, 11 tests. If it fails on `express` not being importable in a test context, that is the signal the pure function has been coupled to the router — move `computeAttention` into its own file and import it from both.

- [ ] **Step 4: Mount and verify**

In `server.js` add the require alongside the others and `app.use('/api/attention', attentionRoutes);` after the challans mount. Then:

```bash
curl -s http://localhost:3000/api/attention/citizen/$CID
```

Expected: JSON with the pending challan item.

- [ ] **Step 5: Commit**

```bash
git add routes/attention.js server.js test/attention.test.js
git commit -m "Serve the attention list"
```

---

### Task 6: The dashboard panel

**Files:**
- Modify: `public/index.html:193-197` (insert the panel as the first child of `.dash-main`)
- Modify: `public/app.js:757` (`openDashboard`)
- Modify: `public/styles.css` (append the `.att` block)

**Interfaces:**
- Consumes: `GET /api/attention/citizen/:id` from Task 5.
- Produces: `renderAttention(items)` and the `pay-challan` action.

- [ ] **Step 1: Add the markup**

In `public/index.html`, immediately after `<div class="dash-main">` on line 193:

```html
        <div class="panel" id="attention-panel">
          <div class="panel-head"><span class="panel-head-main"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a7 7 0 0 0-7 7c0 3-1 4.5-2 6h18c-1-1.5-2-3-2-6a7 7 0 0 0-7-7Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>Needs your attention</span> <span class="sub" id="attention-count">None</span></div>
          <div class="panel-body">
            <div id="attention-list"></div>
            <p class="hint" id="attention-disclosure">In a live service these would also reach you by SMS. This prototype works them out when you open the page and sends nothing.</p>
          </div>
        </div>
```

- [ ] **Step 2: Render it**

In `public/app.js`, add above `openDashboard`:

```js
var ATTENTION_LABELS = { act: 'Act now', soon: 'Soon', info: 'Heads up' };

// The empty state is the feature, so this panel never hides. "Nothing needs your
// attention" is the whole posture stated outright.
function renderAttention(items){
  var host = document.getElementById('attention-list');
  document.getElementById('attention-count').textContent =
    items.length === 0 ? 'All clear' : items.length + (items.length === 1 ? ' item' : ' items');

  if(!items.length){
    host.innerHTML = '<p class="att-clear">✓ Nothing needs your attention. We will tell you when it does.</p>';
    return;
  }

  host.innerHTML = items.map(function(item){
    var action = item.action
      ? '<button class="btn ghost small" data-action="' + escapeHtml(item.action.type) + '"' +
        (item.action.id ? ' data-id="' + escapeHtml(String(item.action.id)) + '"' : '') + '>' +
        escapeHtml(item.action.label) + '</button>'
      : '';
    return '<div class="att att-' + escapeHtml(item.severity) + '">' +
      '<div class="att-head"><span class="att-sev">' + ATTENTION_LABELS[item.severity] + '</span>' +
      '<span class="att-title">' + escapeHtml(item.title) + '</span></div>' +
      '<p class="att-detail">' + escapeHtml(item.detail) + '</p>' +
      '<div class="att-foot"><span class="att-source">Because: ' + escapeHtml(item.source) + '</span>' + action + '</div>' +
    '</div>';
  }).join('');
}

async function loadAttention(){
  var data = await api('/api/attention/citizen/' + session.citizen.id);
  session.attention = data.items;
  renderAttention(data.items);
}
```

Then inside `openDashboard`, after the citizen fields are set and before the applications fetch, add:

```js
  await loadAttention();
```

- [ ] **Step 3: Add the pay action**

In `handleAction`, alongside the other arms:

```js
    else if(action === 'pay-challan'){
      var challanId = el.getAttribute('data-id');
      el.disabled = true;
      el.textContent = 'Paying…';
      await api('/api/challans/' + challanId + '/pay', { method:'POST' });
      await loadAttention();
    }
```

- [ ] **Step 4: Style it**

Append to `public/styles.css`:

```css
  /* Never hidden when empty: "nothing needs your attention" is the point. */
  .att{border:1px solid var(--rule);border-left:4px solid var(--rule);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:10px;}
  .att:last-of-type{margin-bottom:0;}
  .att-act{border-left-color:var(--red);}
  .att-soon{border-left-color:var(--saffron);}
  .att-info{border-left-color:var(--indigo);}
  .att-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
  .att-sev{flex:0 0 auto;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:99px;}
  .att-act .att-sev{background:var(--red-soft);color:var(--red);}
  .att-soon .att-sev{background:var(--saffron-soft);color:var(--saffron-deep);}
  .att-info .att-sev{background:var(--indigo-soft);color:var(--indigo);}
  .att-title{font-size:14.5px;font-weight:700;color:var(--ink);}
  .att-detail{margin:6px 0 8px;font-size:13.5px;line-height:1.5;color:var(--ink-soft);}
  .att-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
  .att-source{font-size:11.5px;font-weight:600;color:var(--ink-faint);}
  .att-clear{margin:0;font-size:14px;font-weight:600;color:var(--green);}
  #attention-disclosure{margin-top:14px;padding-top:12px;border-top:1px solid var(--rule-soft);font-size:12px;}
  @media(max-width:560px){.att-foot{align-items:flex-start;flex-direction:column;}}
```

- [ ] **Step 5: Check it by eye**

Run `node server.js`, sign in as `9000000009` / `123456`, and confirm: the panel is the first thing in the main column, the challan shows as act-now with its `Because:` line, paying it makes the row disappear and the panel switch to the all-clear state.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "Show what needs the citizen's attention"
```

---

### Task 7: Grievance grounding

**Files:**
- Modify: `routes/grievances.js` — `buildFactSheet`, `TRIAGE_SCHEMA`, `SYSTEM_PROMPT`, and the services query
- Modify: `public/app.js` — `grievanceRow` to render the source

**Interfaces:**
- Consumes: the `services` table.
- Produces: triage output gains `source: string`; grievance rows gain a rendered source line.

**Defer this task if the plan is running long** — the spec names it as the piece to cut. The attention surface and the challan blocker are the story.

- [ ] **Step 1: Widen the fact sheet**

In `routes/grievances.js`, in the POST handler, fetch the rules alongside the applications:

```js
  const rules = await pool.query(
    `SELECT key, title, form_number, fee_cents, expected_days,
            requires_slot, carry_items, prerequisite_note, eligibility
     FROM services ORDER BY key`
  );
```

Then extend `buildFactSheet(citizen, applications)` to `buildFactSheet(citizen, applications, services)` and append before the return:

```js
  const ruleLines = services.map((s) => {
    const bits = [
      `${s.title} (${s.form_number}): fee ₹${Math.round(s.fee_cents / 100)}`,
      `usually ${s.expected_days} days`,
      s.requires_slot ? `needs an RTO visit — carry: ${s.carry_items}` : 'no RTO visit needed',
      s.prerequisite_note ? `requirement: ${s.prerequisite_note}` : null,
      s.eligibility && s.eligibility.form1aMinAge
        ? `medical certificate Form 1A required at age ${s.eligibility.form1aMinAge}+ or for a Transport class`
        : null,
    ];
    return '- ' + bits.filter(Boolean).join('; ');
  });
```

and include `'Service rules:', ...ruleLines` in the joined array.

- [ ] **Step 2: Require a source**

Add to `TRIAGE_SCHEMA.properties`, and to its `required` array:

```js
    source: {
      type: 'string',
      description: 'What this answer was drawn from — a reference code from their applications, or the named service rule. Use "none" if the answer came from neither, in which case answered_immediately must be false.',
    },
```

Add to `SYSTEM_PROMPT`:

```js
  'GROUNDING. You may only answer from the facts and the service rules given. If a question is not covered by either — a policy the rules do not state, or anything about another agency — you may not answer it: set answered_immediately to false, set source to "none", and route it to a human. Guessing plausibly is the failure this rule exists to prevent.',
```

- [ ] **Step 3: Persist and render it**

Add `source` to the insert alongside `language` (a `source TEXT` column via `ALTER TABLE grievances ADD COLUMN IF NOT EXISTS source TEXT;` appended to `db/schema.sql`, then `npm run db:migrate`), and in `grievanceRow` in `public/app.js` add below the reply:

```js
    (g.source && g.source !== 'none'
      ? '<p class="grv-source">Answered from: ' + escapeHtml(g.source) + '</p>'
      : '') +
```

with:

```css
  .grv-source{margin:0 16px 8px;font-size:11.5px;font-weight:600;color:var(--ink-faint);}
```

- [ ] **Step 4: Verify the guard holds**

With the server running and a paid application on the demo account, submit *"Do I need to bring my old licence, or is a digital copy enough?"* — the rules do not cover it, so it must route to a human rather than answer. Then submit *"When will my licence be ready?"* — that must answer on the spot with `source` naming the reference code.

- [ ] **Step 5: Confirm the multilingual behaviour survived**

Run the existing check with a Hindi and a Telugu complaint; each must still reply in its own script with an English summary. The fact sheet has grown, so this is a real regression risk.

- [ ] **Step 6: Commit**

```bash
git add routes/grievances.js public/app.js public/styles.css db/schema.sql
git commit -m "Let the triage answer only from rules it can name"
```

---

### Task 8: Fix the two remaining hardcoded claims

**Files:**
- Modify: `public/index.html:213` (the "Valid till" cell) and the "Renewal due" chip above it
- Modify: `public/app.js` — `openDashboard`

**Interfaces:**
- Consumes: `citizen.dl_expires_on` from Task 3.

- [ ] **Step 1: Give the cells ids**

In `public/index.html`, change the hardcoded cell to:

```html
              <div class="m"><span class="k">Valid till</span><span class="v" id="doc-dl-expiry">—</span></div>
```

and give the chip an id: `<span class="doc-card-chip" id="doc-dl-chip">Renewal due</span>`

- [ ] **Step 2: Drive them from the record**

In `openDashboard`, alongside the other citizen fields:

```js
  var expiry = session.citizen.dl_expires_on;
  document.getElementById('doc-dl-expiry').textContent = expiry ? formatDate(expiry) : '—';
  var chip = document.getElementById('doc-dl-chip');
  var daysLeft = expiry ? Math.round((new Date(expiry) - Date.now()) / 86400000) : null;
  chip.hidden = daysLeft === null || daysLeft > 60;
  chip.textContent = daysLeft !== null && daysLeft < 0 ? 'Expired' : 'Renewal due';
```

- [ ] **Step 3: Check both states**

Sign in as a citizen with an expiry inside 60 days and confirm the chip shows; set one far in the future and confirm it hides.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "Show the real licence expiry instead of a fixed date"
```

---

## Self-review

**Spec coverage.** `dl_expires_on` → Task 3. `challans` table → Task 3. Attention endpoint → Tasks 1, 2, 5. Dashboard panel with empty state and disclosure → Task 6. Challan blocker on `renew` and `dl` → Task 4. Pay-to-clear, idempotent → Task 4. Grievance grounding with `source` → Task 7. Hardcoded "Valid till" and "Renewal due" → Task 8. Ordering by severity → Task 2. Every spec section maps to a task.

**Deliberate omissions.** `document_missing` and `will_block` from the spec's table are not implemented. Both need the uploads and eligibility logic that currently lives only in the client, and neither earns its cost against the demo. Recorded here rather than silently dropped — add them only if Task 7 is deferred and time remains.

**Type consistency.** `computeAttention` keeps one signature throughout. `item.action` is `{ label, type, id? }` in Tasks 1, 2 and 6. `payment_status` is `null` or a string in Tasks 2 and 5. `pendingChallan` and `BLOCKED_SERVICES` are exported in Task 4 and imported in the same shapes.

**Known risk.** Task 5 makes `routes/attention.js` require `express`, which the Task 1 test imports transitively. Step 3 of Task 5 names the symptom and the fix — split the pure function into its own file — rather than leaving it to be discovered.
