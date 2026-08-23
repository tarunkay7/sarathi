# Sarathi

A prototype reimagining India's driving-licence portal (Sarathi Parivahan Sewa) for the "Build What Moves India" hackathon. Not affiliated with or endorsed by MoRTH or NIC — all data is mock/synthetic.

## Stack

- Frontend: static HTML/CSS/JS (`sarathi.html`), served by the backend
- Backend: Node.js + Express (`server.js`, `routes/`)
- Database: Postgres, hosted on [Neon](https://neon.tech)
- Deployment: [Render](https://render.com), via `render.yaml` (auto-deploys on push to `main`)

## Prerequisites

- Node.js 20+ and npm
- A Neon Postgres connection string (ask a teammate for it — never commit it)

## Setup

1. Clone the repo and install dependencies:
   ```
   git clone https://github.com/tarunkay7/sarathi.git
   cd sarathi
   npm install
   ```

2. Create a `.env` file in the project root (copy `.env.example`) and fill in the real value:
   ```
   DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
   ```
   Get the actual connection string from a teammate over a private channel — do not paste it in a commit, issue, or PR.

3. Apply the schema and seed the four licence services:
   ```
   npm run db:migrate
   npm run db:seed
   ```

4. Start the server:
   ```
   npm start
   ```
   Open **http://localhost:3000** — this serves both the frontend and the API from the same origin.

## Demo login

There's no real SMS OTP integration. Enter any 10-digit mobile number and use `123456` as the OTP to log in.

## Project structure

```
sarathi.html        frontend (screens, styles, client JS)
server.js            Express app entrypoint
routes/              API routes (auth, applications, payments)
db/
  schema.sql         table definitions
  migrate.js         applies schema.sql to DATABASE_URL
  seed.js            seeds the 4 licence services (renew/new/duplicate/address)
  pool.js            Postgres connection pool
render.yaml           Render deployment blueprint
```

## Notes for local development

- If you only need to tweak `sarathi.html`'s look and feel and don't need the backend, you can serve it directly with `npx live-server` for auto-reload on save. Anything that calls `/api/...` (login, applying, paying, tracking) needs the real server — use `npm start` and open port 3000 for that.
- `.env` and `node_modules/` are git-ignored; never commit real credentials.
