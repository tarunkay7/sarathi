const express = require('express');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

const TOOLS = [
  {
    type: 'function',
    name: 'start_application',
    description: 'Start the driving licence renewal application for this citizen. Call this once, after the citizen confirms they want to renew.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'confirm_documents',
    description: 'Call this once the citizen confirms they have the required documents ready (existing licence, photo, and Form 1A if it was mentioned as required). No file upload needed — this is a spoken confirmation.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'select_slot',
    description: 'Record the RTO appointment date and time the citizen chose for photo/biometric capture, if their service requires a visit.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Human-readable date, e.g. "02 Sep 2026"' },
        time: { type: 'string', description: 'Time window, e.g. "10:00–11:00 AM"' },
      },
      required: ['date', 'time'],
    },
  },
  {
    type: 'function',
    name: 'make_payment',
    description: 'Charge the renewal fee using the payment method the citizen chose. Only call this after the application has been started (and a slot selected, if one was required).',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['UPI', 'Card', 'Net banking'] },
      },
      required: ['method'],
    },
  },
  {
    type: 'function',
    name: 'finish',
    description: 'Call this once payment is confirmed and the citizen is ready to see their application status/reference number.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

router.post('/session', asyncHandler(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Voice assistant is not configured on this server yet.' });
  }

  const { citizenName, dob, vehicleClasses, rto, formNumber, feeRupees, requiresSlot, form1a } = req.body || {};

  const instructions = [
    'You are Setu, an agentic voice assistant that actually DRIVES a citizen through renewing their Indian driving licence — you are not a chatbot answering questions about the process, you are the one operating it. All data is mock/demo; never claim to contact a real government system.',
    `Citizen: ${citizenName || 'the citizen'}, date of birth ${dob || 'unknown'}, licence class ${vehicleClasses || 'unknown'}, RTO ${rto || 'unknown'}.`,
    `Renewal form: ${formNumber || 'Form 9'}. Fee: ₹${feeRupees != null ? feeRupees : '400'}.`,
    form1a && form1a.required
      ? `A medical certificate (Form 1A) is required for this citizen (${form1a.reason}). State this plainly once, early on.`
      : 'No medical certificate (Form 1A) is required for this citizen.',
    requiresSlot
      ? 'This service requires an RTO visit for photo/biometric capture. Ask for a date and time once, then call select_slot with their choice before payment.'
      : 'This service does not require an RTO visit — skip straight to payment once the application is started.',
    'Be decisive and brisk, not chatty. One short sentence per turn, then act. Do not summarize the whole process up front, do not ask "shall I proceed?" more than once per step, and do not repeat information the citizen can already see on their screen. As soon as you have what you need for a step, call its tool immediately — do not wait for extra confirmation.',
    'Exact order: (1) greet in one line and call start_application, (2) name the required documents (and Form 1A if applicable) in one line, ask them to confirm they have them, and on any affirmative reply call confirm_documents, (3) if a slot is required, ask for a date and time and call select_slot as soon as they answer, (4) ask which payment method and call make_payment as soon as they answer, (5) once payment succeeds, call finish and read back the reference number.',
    'Always call the provided tool to actually perform a step — never claim an application was created or a payment succeeded without calling the corresponding tool first. If a tool call fails, say so plainly and retry once.',
  ].join(' ');

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2',
          instructions,
          audio: {
            input: {
              transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad', silence_duration_ms: 400, create_response: true, interrupt_response: true },
            },
            output: { voice: 'alloy', speed: 0.88 },
          },
          tools: TOOLS,
          tool_choice: 'auto',
        },
      }),
    });
    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      return res.status(502).json({ error: data.error ? data.error.message : 'Failed to start voice session.' });
    }
    res.json({ value: data.value, expires_at: data.expires_at });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the voice assistant service.' });
  }
}));

module.exports = router;
