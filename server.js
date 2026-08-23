require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const paymentRoutes = require('./routes/payments');
const realtimeRoutes = require('./routes/realtime');

const app = express();
app.use(express.json());

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/realtime', realtimeRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
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
  console.log(`Setu backend listening on http://localhost:${port}`);
});
