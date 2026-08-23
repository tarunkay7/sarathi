const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function makeReferenceCode() {
  return 'TS-DL-2026-' + Math.floor(1000 + Math.random() * 9000);
}

router.get('/service/:key', async (req, res) => {
  const result = await pool.query('SELECT * FROM services WHERE key = $1', [req.params.key]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Unknown service' });
  res.json({ service: result.rows[0] });
});

router.get('/citizen/:citizenId', async (req, res) => {
  const apps = await pool.query(
    `SELECT a.*, s.title AS service_title, s.fee_cents, s.requires_slot, s.expected_days, s.form_number
     FROM applications a JOIN services s ON s.key = a.service_key
     WHERE a.citizen_id = $1 ORDER BY a.created_at DESC`,
    [req.params.citizenId]
  );
  res.json({ applications: apps.rows });
});

router.post('/', async (req, res) => {
  const { citizenId, serviceKey, dob } = req.body;
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
});

router.get('/:id', async (req, res) => {
  const appResult = await pool.query(
    `SELECT a.*, s.title AS service_title, s.fee_cents, s.checklist, s.eligibility
     FROM applications a JOIN services s ON s.key = a.service_key
     WHERE a.id = $1`,
    [req.params.id]
  );
  const application = appResult.rows[0];
  if (!application) return res.status(404).json({ error: 'Not found' });

  const timeline = await pool.query(
    'SELECT * FROM timeline_events WHERE application_id = $1 ORDER BY occurred_at DESC',
    [req.params.id]
  );
  res.json({ application, timeline: timeline.rows });
});

router.post('/:id/escalate', async (req, res) => {
  const updated = await pool.query(
    `UPDATE applications SET escalated = TRUE, escalated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!updated.rows[0]) return res.status(404).json({ error: 'Not found' });

  await pool.query(
    `INSERT INTO timeline_events (application_id, label) VALUES ($1, 'Auto-escalated to supervisor')`,
    [req.params.id]
  );
  res.json({ application: updated.rows[0] });
});

module.exports = router;
