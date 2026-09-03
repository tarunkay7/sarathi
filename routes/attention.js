// Computed, never stored. An attention list built from rows that already exist
// cannot go stale, and cannot claim anything the database does not hold.
//
// computeAttention is pure and takes its own clock so it can be tested without
// a database — DATABASE_URL points at the live instance both deployments serve
// from, so no test may go near it.

const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

function rupees(cents) {
  return '₹' + Math.round(cents / 100).toLocaleString('en-IN');
}

// node-pg returns a DATE column as a JS Date, but fixtures/tests may pass a
// plain date string — accept either so both shapes render the same way.
function formatDate(value) {
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
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
      detail: `${challan.offence}, issued ${formatDate(challan.issued_on)}. This blocks a new or renewed licence.`,
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
