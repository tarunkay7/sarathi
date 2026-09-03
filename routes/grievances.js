const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

function makeTicketCode() {
  return 'GRV-2026-' + Math.floor(1000 + Math.random() * 9000);
}

function requireInteger(value, res) {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return Number(value);
}

// Which desk owns which category is a routing rule, not a judgement call, so it
// stays here rather than being something the model can invent a name for.
const DESKS = {
  payment: 'RTO accounts desk',
  delay: 'RTO application desk',
  appointment: 'RTO appointment desk',
  document: 'RTO verification desk',
  licence_error: 'RTO records desk',
  staff_conduct: 'RTO grievance officer',
  other: 'RTO help desk',
};
const CATEGORIES = Object.keys(DESKS);

// Working days the citizen is promised a reply in. Deliberately short for the
// serious ones — the point of triaging at all is that severity changes the SLA.
const SLA_DAYS = { high: 2, normal: 5, low: 7 };

const CATEGORY_LABELS = {
  payment: 'Payment',
  delay: 'Delay',
  appointment: 'Appointment',
  document: 'Documents',
  licence_error: 'Error on licence',
  staff_conduct: 'Staff conduct',
  other: 'General',
};

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'severity', 'language', 'summary', 'citizen_reply', 'answered_immediately', 'source'],
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    language: {
      type: 'string',
      description: 'The language the citizen wrote or spoke in, as its English name — Hindi, Telugu, Tamil, Marathi, Bengali, Kannada, English, and so on.',
    },
    severity: {
      type: 'string',
      enum: ['low', 'normal', 'high'],
      description: 'high only for money lost, a wrong licence already issued, or a missed legal deadline.',
    },
    summary: {
      type: 'string',
      description: 'One neutral sentence an RTO officer can act on, naming the application if there is one. ALWAYS in English, whatever language the citizen used — the officer reading it may not share it.',
    },
    citizen_reply: {
      type: 'string',
      description: 'Two or three short warm sentences addressed to the citizen, saying what happens next, WRITTEN IN THE SAME LANGUAGE THEY USED. If the question is answerable from the applications given, answer it concretely with the real reference code and date. Reference codes, dates and amounts stay in their original form, never transliterated.',
    },
    answered_immediately: {
      type: 'boolean',
      description: 'True only when the applications given already fully answer the complaint and no officer needs to act.',
    },
    source: {
      type: 'string',
      description: 'What this answer was drawn from — a reference code from their applications, or the named service rule. Use "none" if the answer came from neither, in which case answered_immediately must be false.',
    },
  },
};

// Everything the model is allowed to treat as fact. Built from the citizen's own
// rows so a status answer quotes a real reference code and date rather than a
// plausible-looking one, plus the service rules so a policy question has
// something real to cite instead of the model guessing a plausible answer.
function buildFactSheet(citizen, applications, services) {
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

  if (!applications.length) {
    return [
      `${citizen.name} has no applications on record. Their RTO is ${citizen.rto}, ${citizen.state}.`,
      'Service rules:',
      ...ruleLines,
    ].join('\n');
  }
  const lines = applications.map((a) => {
    const parts = [
      `${a.reference_code}: ${a.service_title}`,
      `status ${a.status}`,
      `fee ₹${Math.round(a.fee_cents / 100)}`,
      `submitted ${new Date(a.created_at).toISOString().slice(0, 10)}`,
      a.expected_by ? `expected by ${new Date(a.expected_by).toISOString().slice(0, 10)}` : null,
      a.escalated ? 'ALREADY auto-escalated to a supervisor' : null,
      a.payment_status ? `payment ${a.payment_status}` : 'no payment recorded',
    ];
    return '- ' + parts.filter(Boolean).join(', ');
  });
  return [
    `Citizen: ${citizen.name}, RTO ${citizen.rto}, ${citizen.state}. Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Their applications:',
    ...lines,
    'Service rules:',
    ...ruleLines,
  ].join('\n');
}

const SYSTEM_PROMPT = [
  'You triage grievances for an Indian RTO driving-licence service. You are given a citizen\'s complaint in their own words and the full set of facts about their applications.',
  'Classify it, then write a reply the citizen will read.',
  'Use ONLY the facts provided. Never invent a reference code, date, amount, officer name or office. If a fact is not listed, do not state it.',
  'If their complaint is a question that the facts already answer — most often "where is my application" or "when will it be ready" — set answered_immediately to true and answer it directly, quoting the real reference code and expected date. Do not promise an officer will follow up on something already answered.',
  'If it needs a human, set answered_immediately to false and tell them plainly that it has been logged and routed, without inventing a timeline.',
  'Severity decides how fast a human must reply, so apply it strictly. Use high whenever money has left the citizen\'s account and is unaccounted for, a bribe or extortion is described, a licence has already been issued with wrong details, or a legal deadline has been missed. Use low only for general questions where nothing is at stake. Everything else is normal.',
  'Never claim to have contacted a real government system, and never ask for an Aadhaar number, OTP, card or bank detail.',
  'Write at a sixth-standard reading level. No jargon, no apologising twice, no filler.',
  'LANGUAGE. A citizen who complains in Telugu should not be answered in English. Identify the language they used and write citizen_reply in it, in that language\'s own script. The officer-facing summary is always English, because the desk reading it may not share the citizen\'s language. Leave reference codes, dates and amounts exactly as they appear — never transliterate or translate those.',
  'GROUNDING. You may only answer from the facts and the service rules given. If a question is not covered by either — a policy the rules do not state, or anything about another agency — you may not answer it: set answered_immediately to false, set source to "none", and route it to a human. Guessing plausibly is the failure this rule exists to prevent.',
].join(' ');

// Keyword triage, used when there is no API key or the model call fails. Coarse
// on purpose: it exists so the grievance is still accepted and routed rather
// than lost, not to be a second implementation of the model.
function triageWithRules(body, spokenLanguage) {
  const text = String(body).toLowerCase();
  const match = [
    ['payment', /paid|payment|money|refund|debit|charge|twice|deduct|upi/],
    ['delay', /delay|late|still waiting|not received|no update|pending|weeks|month/],
    ['appointment', /appointment|slot|booking|reschedul|date|test/],
    ['document', /document|upload|form|certificate|photo|proof/],
    ['licence_error', /wrong|spelling|incorrect|mistake|name|address|error/],
    ['staff_conduct', /rude|behaviour|behavior|bribe|agent|staff|officer|refused/],
  ].find(([, re]) => re.test(text));
  const category = match ? match[0] : 'other';
  return {
    category,
    severity: /bribe|twice|refund|fraud/.test(text) ? 'high' : 'normal',
    summary: `Citizen-reported ${CATEGORY_LABELS[category].toLowerCase()} issue awaiting officer review.`,
    citizen_reply: 'Your grievance has been logged and routed to the right desk. You will get an SMS when an officer picks it up, and you can see its status on your dashboard at any time.',
    // The keyword fallback cannot translate, so it records the language it was
    // unable to answer in rather than pretending English was the right choice.
    language: spokenLanguage || 'English',
    answered_immediately: false,
    // The keyword match never reads a fact sheet, so it never has a source to name.
    source: 'none',
  };
}

async function triageWithOpenAI(body, factSheet, spokenLanguage) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TRIAGE_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `FACTS\n${factSheet}\n\n${spokenLanguage ? `Speech recognition detected the citizen spoke this in ${spokenLanguage}.\n\n` : ''}COMPLAINT\n${body}` },
      ],
      // strict json_schema means the reply always parses and the category is
      // always one the router knows, so there is no shape to defend against.
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'grievance_triage', strict: true, schema: TRIAGE_SCHEMA },
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ? data.error.message : `Triage failed (HTTP ${res.status})`);
  }
  const content = data.choices && data.choices[0] && data.choices[0].message.content;
  if (!content) throw new Error('Triage returned no content');
  return JSON.parse(content);
}

function addWorkingDays(days) {
  const d = new Date();
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

router.post('/', asyncHandler(async (req, res) => {
  const { citizenId, mobileNumber, applicationId, body, language } = req.body || {};
  // Whisper's detected language, when the complaint was spoken. Only a hint —
  // the model still decides, since a typed complaint has no hint at all.
  const spokenLanguage = String(language || '').trim() || null;
  const requestedCitizen = /^\d+$/.test(String(citizenId || '')) ? Number(citizenId) : null;
  const mobile = String(mobileNumber || '').trim();
  if (requestedCitizen === null && !/^\d{10}$/.test(mobile)) {
    return res.status(400).json({ error: 'Invalid citizen account.' });
  }

  const text = String(body || '').trim();
  if (text.length < 10) {
    return res.status(400).json({ error: 'Please describe the problem in a sentence or two so it can be routed correctly.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Please keep the description under 2000 characters.' });
  }

  // Browser storage can outlive a rebuilt demo database, so its numeric id may
  // be stale. Resolve the current row using the registered login mobile number.
  const citizenResult = /^\d{10}$/.test(mobile)
    ? await pool.query('SELECT * FROM citizens WHERE mobile_number = $1', [mobile])
    : await pool.query('SELECT * FROM citizens WHERE id = $1', [requestedCitizen]);
  if (!citizenResult.rows[0]) {
    return res.status(401).json({ error: 'Your account session has expired. Please log in again and resubmit your grievance.' });
  }
  const citizen = citizenResult.rows[0].id;

  // Optional, and must belong to this citizen — otherwise a ticket could be
  // attached to someone else's application.
  let linkedApplication = null;
  let linkedReference = null;
  if (applicationId !== undefined && applicationId !== null && applicationId !== '') {
    const linked = requireInteger(applicationId, res);
    if (linked === null) return;
    const owned = await pool.query(
      'SELECT id, reference_code FROM applications WHERE id = $1 AND citizen_id = $2',
      [linked, citizen]
    );
    if (!owned.rows[0]) return res.status(400).json({ error: 'That application is not on this account.' });
    linkedApplication = linked;
    linkedReference = owned.rows[0].reference_code;
  }

  const appsResult = await pool.query(
    `SELECT a.id, a.reference_code, a.status, a.expected_by, a.escalated, a.created_at,
            s.title AS service_title, s.fee_cents,
            (SELECT p.status FROM payments p
              WHERE p.application_id = a.id AND p.status IN ('reconciling','paid')
              LIMIT 1) AS payment_status
     FROM applications a
     JOIN services s ON s.key = a.service_key
     WHERE a.citizen_id = $1
     ORDER BY a.id DESC`,
    [citizen]
  );

  // The four keys this app actually offers. The services table also still
  // carries the stale 'address' / "Change of Address" row (₹200) — retired by
  // commit 1a09de2 in favour of 'dl', but never deleted because an old
  // application still references it via the service_key foreign key. Feeding
  // it to the model would teach the fact sheet about a service the app does
  // not offer, so it is filtered out here rather than left for the model to
  // stumble on.
  const rules = await pool.query(
    `SELECT key, title, form_number, fee_cents, expected_days,
            requires_slot, carry_items, prerequisite_note, eligibility
     FROM services WHERE key IN ('renew','new','duplicate','dl') ORDER BY key`
  );

  const factSheet = buildFactSheet(citizenResult.rows[0], appsResult.rows, rules.rows);

  let triage;
  let triagedBy = 'openai';
  if (!process.env.OPENAI_API_KEY) {
    triage = triageWithRules(text, spokenLanguage);
    triagedBy = 'rules';
  } else {
    try {
      triage = await triageWithOpenAI(text, factSheet, spokenLanguage);
    } catch (err) {
      // A grievance must never be lost because a third party was unavailable.
      console.warn('[grievance] OpenAI triage failed, using keyword fallback:', err.message);
      triage = triageWithRules(text, spokenLanguage);
      triagedBy = 'rules';
    }
  }

  const severity = SLA_DAYS[triage.severity] ? triage.severity : 'normal';
  const category = DESKS[triage.category] ? triage.category : 'other';
  const answered = Boolean(triage.answered_immediately);

  const inserted = await pool.query(
    `INSERT INTO grievances
       (ticket_code, citizen_id, application_id, body, category, severity, summary,
        route_to, citizen_reply, answered_immediately, triaged_by, status, expected_by, language, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      makeTicketCode(), citizen, linkedApplication, text, category, severity,
      triage.summary, DESKS[category], triage.citizen_reply, answered, triagedBy,
      answered ? 'answered' : 'open',
      answered ? null : addWorkingDays(SLA_DAYS[severity]),
      String(triage.language || spokenLanguage || 'English').trim(),
      String(triage.source || 'none').trim(),
    ]
  );

  const grievance = inserted.rows[0];
  if (linkedApplication) {
    await pool.query(
      `INSERT INTO timeline_events (application_id, label) VALUES ($1, $2)`,
      [linkedApplication, `Grievance ${grievance.ticket_code} raised (${CATEGORY_LABELS[category]})`]
    );
  }

  // reference_code matches what the list endpoint joins in, so the outcome card
  // and the history row render from the same shape.
  res.status(201).json({
    grievance: { ...grievance, category_label: CATEGORY_LABELS[category], reference_code: linkedReference },
  });
}));

router.get('/citizen/:id', asyncHandler(async (req, res) => {
  const id = requireInteger(req.params.id, res);
  if (id === null) return;
  const result = await pool.query(
    `SELECT g.*, a.reference_code
     FROM grievances g
     LEFT JOIN applications a ON a.id = g.application_id
     WHERE g.citizen_id = $1 ORDER BY g.id DESC`,
    [id]
  );
  res.json({
    grievances: result.rows.map((g) => ({ ...g, category_label: CATEGORY_LABELS[g.category] || 'General' })),
  });
}));

module.exports = router;
