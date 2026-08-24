const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

function makeReferenceCode() {
  return 'TS-DL-2026-' + Math.floor(1000 + Math.random() * 9000);
}

// A rejected embed URL still renders inside the iframe as Google's own error
// page, and the browser cannot detect that cross-origin. So probe the Embed
// API once here and withhold embedUrl when it is unavailable, letting the
// client fall back to the keyless directions link instead.
// Keys are normally locked to HTTP referrers, so the probe has to send the
// same Referer the browser will, or it gets rejected for a request the real
// iframe would have completed. Cached per origin (dev and prod differ).
const EMBED_PROBE_TTL_MS = 5 * 60 * 1000;
const embedProbes = new Map();

async function embedApiAvailable(sampleUrl, origin) {
  const cached = embedProbes.get(origin);
  if (cached && Date.now() - cached.checkedAt < EMBED_PROBE_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const probe = await fetch(sampleUrl, { headers: { Referer: origin + '/' } });
    ok = probe.ok;
    if (!ok) {
      const body = await probe.text();
      const reason = /not activated/i.test(body)
        ? 'Maps Embed API is not enabled on this key\'s Cloud project'
        : /not authorized/i.test(body)
          ? `referer ${origin}/ is not in the key's allowed HTTP referrers`
          : `HTTP ${probe.status}`;
      console.warn(`[maps] Embed unavailable — ${reason}. Falling back to directions link.`);
    }
  } catch (err) {
    console.warn('[maps] Embed API probe failed:', err.message);
  }
  embedProbes.set(origin, { checkedAt: Date.now(), ok });
  return ok;
}

// The Maps key is unavoidably public (it ships inside the iframe src), so it
// is protected by HTTP-referrer restrictions in Cloud Console rather than by
// being hidden. mapsLink needs no key and always works.
async function buildRtoPayload(row, origin) {
  if (!row.rto_map_query) return null;
  const query = encodeURIComponent(row.rto_map_query);
  const key = process.env.GOOGLE_MAPS_STATIC_KEY;
  const embedUrl = key ? `https://www.google.com/maps/embed/v1/place?key=${key}&q=${query}` : null;
  return {
    name: row.rto_name,
    city: row.rto_city,
    state: row.rto_state,
    address: row.rto_address,
    hours: row.rto_hours,
    mapsLink: `https://www.google.com/maps/search/?api=1&query=${query}`,
    embedUrl: embedUrl && (await embedApiAvailable(embedUrl, origin)) ? embedUrl : null,
  };
}

function requireInteger(value, res) {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return Number(value);
}

router.get('/service/:key', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM services WHERE key = $1', [req.params.key]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Unknown service' });
  res.json({ service: result.rows[0] });
}));

router.get('/citizen/:citizenId', asyncHandler(async (req, res) => {
  const citizenId = requireInteger(req.params.citizenId, res);
  if (citizenId === null) return;
  const apps = await pool.query(
    `SELECT a.*, s.title AS service_title, s.fee_cents, s.requires_slot, s.expected_days, s.form_number
     FROM applications a JOIN services s ON s.key = a.service_key
     WHERE a.citizen_id = $1 ORDER BY a.created_at DESC`,
    [citizenId]
  );
  res.json({ applications: apps.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { citizenId, serviceKey, dob } = req.body;
  if (requireInteger(citizenId, res) === null) return;

  const serviceResult = await pool.query('SELECT * FROM services WHERE key = $1', [serviceKey]);
  const service = serviceResult.rows[0];
  if (!service) return res.status(400).json({ error: 'Unknown service' });

  if (dob) {
    await pool.query('UPDATE citizens SET dob = $1 WHERE id = $2', [dob, citizenId]);
  }

  const referenceCode = makeReferenceCode();
  const expectedBy = new Date();
  expectedBy.setDate(expectedBy.getDate() + service.expected_days);

  const inserted = await pool.query(
    `INSERT INTO applications (reference_code, citizen_id, service_key, status, expected_by)
     VALUES ($1,$2,$3,'details',$4) RETURNING *`,
    [referenceCode, citizenId, serviceKey, expectedBy]
  );
  const application = inserted.rows[0];
  await pool.query(
    `INSERT INTO timeline_events (application_id, label) VALUES ($1, 'Application started')`,
    [application.id]
  );
  res.status(201).json({ application });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;

  const appResult = await pool.query(
    `SELECT a.*, s.title AS service_title, s.fee_cents, s.checklist, s.eligibility,
            s.requires_slot, s.expected_days, s.form_number, s.slot_purpose, s.carry_items,
            r.name AS rto_name, r.city AS rto_city, r.state AS rto_state,
            r.map_query AS rto_map_query, r.address AS rto_address, r.hours AS rto_hours
     FROM applications a
     JOIN services s ON s.key = a.service_key
     JOIN citizens c ON c.id = a.citizen_id
     LEFT JOIN rtos r ON r.name = c.rto AND r.state = c.state
     WHERE a.id = $1`,
    [id]
  );
  const application = appResult.rows[0];
  if (!application) return res.status(404).json({ error: 'Not found' });

  const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
  const rto = await buildRtoPayload(application, origin);

  const timeline = await pool.query(
    'SELECT * FROM timeline_events WHERE application_id = $1 ORDER BY occurred_at DESC',
    [id]
  );
  res.json({ application, timeline: timeline.rows, rto });
}));

router.post('/:id/escalate', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;

  const updated = await pool.query(
    `UPDATE applications SET escalated = TRUE, escalated_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!updated.rows[0]) return res.status(404).json({ error: 'Not found' });

  await pool.query(
    `INSERT INTO timeline_events (application_id, label) VALUES ($1, 'Auto-escalated to supervisor')`,
    [id]
  );
  res.json({ application: updated.rows[0] });
}));

module.exports = router;
