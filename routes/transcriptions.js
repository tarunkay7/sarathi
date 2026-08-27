const express = require('express');
const asyncHandler = require('./asyncHandler');

const router = express.Router();

const AUDIO_TYPES = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'application/octet-stream': 'webm',
};

router.post('/grievance', express.raw({
  type: Object.keys(AUDIO_TYPES),
  limit: '4mb',
}), asyncHandler(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'Voice transcription is not configured on this server.' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'No audio recording was received.' });
  }

  const contentType = String(req.headers['content-type'] || 'audio/webm').split(';')[0].toLowerCase();
  const extension = AUDIO_TYPES[contentType];
  if (!extension) {
    return res.status(415).json({ error: 'This audio format is not supported. Please try recording again.' });
  }

  const form = new FormData();
  form.append('model', process.env.OPENAI_TRANSLATE_MODEL || 'whisper-1');
  form.append('prompt', 'Translate this citizen grievance into clear English. Preserve names, reference numbers, amounts, dates, RTO names, and driving-licence terms accurately.');
  form.append('file', new Blob([req.body], { type: contentType }), `grievance.${extension}`);

  const openaiRes = await fetch('https://api.openai.com/v1/audio/translations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await openaiRes.json();
  if (!openaiRes.ok) {
    console.warn('[translation] OpenAI request failed:', data.error && data.error.message);
    return res.status(502).json({ error: 'The recording could not be translated. Please try again or type your grievance.' });
  }

  const text = String(data.text || '').trim();
  if (!text) return res.status(422).json({ error: 'No speech was detected in the recording.' });
  res.json({ text });
}));

module.exports = router;
