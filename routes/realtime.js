const express = require('express');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

function buildTools(availableDates, slotTimes) {
  const dateEnum = availableDates && availableDates.length ? availableDates : undefined;
  const timeEnum = slotTimes && slotTimes.length ? slotTimes : undefined;
  return [
    {
      type: 'function',
      name: 'begin_intake',
      description: 'Call this the moment the citizen gives a plain "yes" (or equivalent) to your question "are you ready to start your renewal application?" — this reveals their application form on screen. Call it only once, right after that confirmation, before anything else.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      type: 'function',
      name: 'start_application',
      description: 'Start the driving licence renewal application for this citizen. Only call this after begin_intake has already been called AND you have read back their name, date of birth, licence class, and RTO out loud and they have explicitly confirmed those details are correct — never call it before that confirmation.',
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
      description: 'Show a proposed RTO appointment date and time as a live card on the citizen\'s screen as soon as they mention one — this only previews/updates the UI, it does NOT move the process forward. You must call confirm_slot afterwards, once the citizen confirms, to actually lock it in. Only ever pass a date and time from the allowed lists you were given — there is no calendar on screen, only your voice and this card, so never invent a value outside those lists.',
      parameters: {
        type: 'object',
        properties: {
          date: dateEnum ? { type: 'string', enum: dateEnum, description: 'Must be exactly one of the available dates you were told.' } : { type: 'string', description: 'Human-readable date, e.g. "02 Sep 2026"' },
          time: timeEnum ? { type: 'string', enum: timeEnum, description: 'Must be exactly one of the available time windows you were told.' } : { type: 'string', description: 'Time window, e.g. "10:00–11:00 AM"' },
        },
        required: ['date', 'time'],
      },
    },
    {
      type: 'function',
      name: 'confirm_slot',
      description: 'Lock in the appointment date/time that was just shown with select_slot and move on to payment. Only call this after select_slot has already shown a proposed card AND the citizen has explicitly confirmed it.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      type: 'function',
      name: 'make_payment',
      description: 'Charge the renewal fee using the payment method the citizen chose. Only call this after the application has been started (and a slot confirmed, if one was required).',
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
}

router.post('/session', asyncHandler(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Voice assistant is not configured on this server yet.' });
  }

  const { citizenName, dob, vehicleClasses, rto, formNumber, feeRupees, requiresSlot, form1a, checklist, earliestSlotDate, availableDates, slotTimes } = req.body || {};

  const firstName = (citizenName || 'there').split(' ')[0];
  const docLines = (checklist || []).map((item) => {
    if (item.badge && /digilocker/i.test(item.badge)) {
      return `${item.label} (this is fetched automatically from DigiLocker on their behalf — ask them to confirm that's okay)`;
    }
    if (item.badge) return `${item.label} (${item.badge})`;
    return item.label;
  });

  const instructions = [
    `You are Setu, a warm, genuinely helpful voice assistant who actually DRIVES ${firstName} through renewing their Indian driving licence — you are not a chatbot answering questions, you are the one operating the process for them. All data is mock/demo; never claim to contact a real government system.`,
    `Citizen: ${citizenName || 'the citizen'}, date of birth ${dob || 'unknown'}, licence class ${vehicleClasses || 'unknown'}, RTO ${rto || 'unknown'}.`,
    `Renewal form: ${formNumber || 'Form 9'}. Fee: ₹${feeRupees != null ? feeRupees : '400'}.`,
    docLines.length ? `Documents needed: ${docLines.join('; ')}.` : '',
    form1a && form1a.required
      ? `A medical certificate (Form 1A) is required for this citizen (${form1a.reason}). Mention it warmly but plainly once, early on — don't make it sound alarming.`
      : 'No medical certificate (Form 1A) is required for this citizen.',
    requiresSlot
      ? `This service requires a short RTO visit for photo/biometric capture. There is no calendar for the citizen to look at — you are their only way of finding out what's available, and their screen just shows a card that mirrors whatever you say. The ONLY dates you may offer or accept are: ${(availableDates || []).join(', ') || 'the ones you were given'}. The ONLY time windows are: ${(slotTimes || []).join(', ') || 'the ones you were given'}. You already know this exact list — never invent a date outside it. If the citizen names a date that isn't in the list, say so IMMEDIATELY and plainly in your very first sentence (e.g. "30th September isn't available — the nearest option is ...") — never say filler like "let me check" or "give me a second" first, since you already know the answer instantly. The earliest open date is ${earliestSlotDate || 'the first one in the list'} — proactively suggest it by name (e.g. "the earliest slot I have is ..., does that work?").`
      : 'This service does not require an RTO visit — skip straight to payment once the application is started.',
    "Tone: warm, patient, and encouraging, like a helpful person at a counter who's genuinely on their side — use their first name naturally once or twice, acknowledge what they say before moving on. But stay efficient: one or two short, friendly sentences per turn, then act. Don't summarize the whole process up front, don't ask 'shall I proceed?' more than once per step, and (other than the one details confirmation at the very start) don't re-read information already visible on their screen. As soon as you have what you need for a step, call its tool right away. Never use stalling filler like 'let me check', 'one moment', 'let me see', or 'give me a second' — you already know everything you need instantly (the documents, the dates, the fee), so answer directly in your first sentence every time.",
    `Good flow, in order: (0) greet ${firstName} warmly by first name in one short line, then ask a plain yes/no question: "are you ready to start your renewal application?" — and wait for their answer. Do not read out any details or call any tool yet. (0.5) The moment they say yes (or an equivalent clear affirmative), immediately call begin_intake — this reveals their application card on screen — before saying anything else. (1) Once begin_intake has been called, read back their key details in one short line — name, date of birth, licence class, and RTO — and explicitly ask them to confirm those are correct. Do NOT call start_application yet. If they say something is wrong, apologise and note it, but continue (this is a demo, nothing can actually be corrected here) — only once they confirm (or correct and then confirm) do you call start_application. (2) name the required documents (mentioning the DigiLocker-fetched photo and asking them to confirm that's fine, plus Form 1A if applicable) and ask them to confirm they're ready, then on any affirmative reply call confirm_documents, (3) if a slot is required: as SOON as the citizen names or agrees to any date and time (even a first guess), immediately call select_slot with it so their screen updates live with that proposed card — do this before asking for final confirmation, not after. If they then change their mind to a different date/time, call select_slot again with the new one to update the card live. Only after they explicitly confirm the proposed slot (a plain "yes"/"that works"/etc.) do you call confirm_slot to lock it in and move on. (4) ask which payment method they'd like and call make_payment as soon as they answer, (5) once payment succeeds, congratulate them warmly, call finish, and read back the reference number clearly.`,
    'Always call the provided tool to actually perform a step — never claim an application was created or a payment succeeded without calling the corresponding tool first. If select_slot returns an error because the date/time is not available, tell the citizen plainly and immediately propose one of the valid options instead. If a tool call fails for another reason, say so plainly and gently, then retry once.',
  ].filter(Boolean).join(' ');

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
          tools: buildTools(availableDates, slotTimes),
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
