require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const paymentRoutes = require('./routes/payments');
const rtoRoutes = require('./routes/rtos');
const documentRoutes = require('./routes/documents');
const grievanceRoutes = require('./routes/grievances');
const transcriptionRoutes = require('./routes/transcriptions');

const app = express();
app.use(express.json());

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/rtos', rtoRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/grievances', grievanceRoutes);
app.use('/api/transcriptions', transcriptionRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  // Body-parser rejections carry a usable status; a rejected upload should say
  // so rather than surfacing as a generic failure.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That file is too large. Please upload a file under 4 MB.' });
  }
  const status = err.status || err.statusCode;
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ error: 'That request could not be processed. Please check the file and try again.' });
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Sarathi listening on http://localhost:${port}`);
});
