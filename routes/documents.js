const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

const MAX_BYTES = 4 * 1024 * 1024;

// What each upload slot is for. Keyed so the client cannot invent kinds and
// the status page can label them without hardcoding copy.
const DOC_KINDS = {
  signature: { label: 'Specimen signature', accept: ['image/png', 'image/jpeg'] },
  form_1a: { label: 'Medical certificate (Form 1A)', accept: ['image/png', 'image/jpeg', 'application/pdf'] },
};

// Declared Content-Type is attacker-controlled, so confirm the bytes actually
// match. Without this an HTML payload could be stored as image/png and later
// served same-origin.
const MAGIC = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

function sniffMime(buffer) {
  const match = MAGIC.find((sig) => sig.bytes.every((b, i) => buffer[i] === b));
  return match ? match.mime : null;
}

function extensionFor(mime) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf' }[mime] || 'bin';
}

function requireInteger(value, res) {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return Number(value);
}

router.get('/kinds', (req, res) => {
  res.json({
    kinds: Object.entries(DOC_KINDS).map(([key, v]) => ({ key, label: v.label, accept: v.accept })),
    maxBytes: MAX_BYTES,
  });
});

router.get('/application/:applicationId', asyncHandler(async (req, res) => {
  const applicationId = requireInteger(req.params.applicationId, res);
  if (applicationId === null) return;
  // Content is deliberately excluded — listing should not stream file bodies.
  const rows = await pool.query(
    `SELECT id, kind, filename, mime_type, size_bytes, uploaded_at
     FROM documents WHERE application_id = $1 ORDER BY kind`,
    [applicationId]
  );
  res.json({
    documents: rows.rows.map((d) => ({ ...d, label: (DOC_KINDS[d.kind] || {}).label || d.kind })),
  });
}));

// Raw body rather than multipart: a single file per request needs no parser,
// which keeps this dependency-free. The limit rejects oversized bodies before
// they are buffered.
router.post(
  '/',
  express.raw({ type: ['image/png', 'image/jpeg', 'application/pdf'], limit: MAX_BYTES }),
  asyncHandler(async (req, res) => {
    const applicationId = requireInteger(req.query.applicationId, res);
    if (applicationId === null) return;

    const kind = String(req.query.kind || '');
    const spec = DOC_KINDS[kind];
    if (!spec) return res.status(400).json({ error: 'Unknown document type.' });

    // An unsupported Content-Type means express.raw never ran, so req.body is
    // not a Buffer. Report the type rather than a vague "no file".
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!spec.accept.includes(declared)) {
      return res.status(415).json({
        error: `${spec.label} must be ${spec.accept.map((m) => m.split('/')[1].toUpperCase()).join(' or ')}.`,
      });
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'No file received. Attach a PNG, JPG, or PDF.' });
    }

    const sniffed = sniffMime(buffer);
    if (!sniffed) {
      return res.status(415).json({ error: 'That file is not a valid PNG, JPG, or PDF.' });
    }
    if (!spec.accept.includes(sniffed)) {
      return res.status(415).json({
        error: `${spec.label} must be ${spec.accept.map((m) => m.split('/')[1].toUpperCase()).join(' or ')}.`,
      });
    }

    const app = await pool.query('SELECT id FROM applications WHERE id = $1', [applicationId]);
    if (!app.rows[0]) return res.status(404).json({ error: 'Application not found.' });

    // Filename is generated, never taken from the client, so a crafted name
    // cannot influence the download response.
    const filename = `${kind}-${applicationId}.${extensionFor(sniffed)}`;

    const saved = await pool.query(
      `INSERT INTO documents (application_id, kind, filename, mime_type, size_bytes, content)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (application_id, kind) DO UPDATE SET
         filename = EXCLUDED.filename,
         mime_type = EXCLUDED.mime_type,
         size_bytes = EXCLUDED.size_bytes,
         content = EXCLUDED.content,
         uploaded_at = now()
       RETURNING id, kind, filename, mime_type, size_bytes, uploaded_at`,
      [applicationId, kind, filename, sniffed, buffer.length, buffer]
    );

    await pool.query(`INSERT INTO timeline_events (application_id, label) VALUES ($1, $2)`, [
      applicationId,
      `${spec.label} uploaded`,
    ]);

    res.status(201).json({ document: { ...saved.rows[0], label: spec.label } });
  })
);

router.get('/:id/download', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;

  const found = await pool.query('SELECT filename, mime_type, content FROM documents WHERE id = $1', [id]);
  const doc = found.rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  // Always an attachment with a fixed nosniff header: never let a stored file
  // be rendered inline in the app's own origin.
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
  res.send(doc.content);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const removed = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING kind', [id]);
  if (!removed.rows[0]) return res.status(404).json({ error: 'Document not found.' });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.DOC_KINDS = DOC_KINDS;
