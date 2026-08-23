require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const paymentRoutes = require('./routes/payments');

const app = express();
app.use(express.json());

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/payments', paymentRoutes);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'sarathi.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Setu backend listening on http://localhost:${port}`);
});
