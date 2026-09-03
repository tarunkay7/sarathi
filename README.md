# Sarathi

A prototype reimagining India's driving-licence portal (Sarathi Parivahan Sewa) for the "Build What Moves India" hackathon. Not affiliated with or endorsed by MoRTH or NIC — all data is mock/synthetic.

## Stack

- Frontend: static HTML/CSS/JS (`public/`), served by the backend
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

2. Create a `.env` file in the project root (copy `.env.example`) and fill in the real values:
   ```
   DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
   OPENAI_API_KEY=sk-...
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=your_test_key_secret
   RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
   ```
   Get these from a teammate over a private channel — do not paste them in a commit, issue, or PR.

   `OPENAI_API_KEY` powers grievance triage. Without it grievances still file — they fall back to keyword triage, and the UI says which one sorted the ticket. `OPENAI_TRIAGE_MODEL` optionally overrides the triage model (default `gpt-4o-mini`).

   The three `RAZORPAY_*` values are **test-mode** credentials — this is a prototype and must never be pointed at live-mode keys. `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` come from the Razorpay dashboard's API keys page in test mode; `RAZORPAY_WEBHOOK_SECRET` is the secret you set when creating the webhook that delivers `payment.captured` and `payment.failed` to `/api/payments/webhook`. All three are required together: with any of them missing the payment endpoints return 501 rather than taking a payment the server could never confirm.

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
public/
  index.html         markup for every screen
  styles.css         all styles
  app.js             client-side logic (screens, API calls)
server.js            Express app entrypoint
routes/              API routes (auth, applications, payments, documents, grievances)
db/
  schema.sql         table definitions
  migrate.js         applies schema.sql to DATABASE_URL
  seed.js            seeds the 4 licence services (renew/new/duplicate/dl)
  pool.js            Postgres connection pool
  README.md          schema documentation — tables, columns, relationships
GRIEVANCES.md        the grievance feature — what can be raised, how it is triaged
DESIGN.md            colours, fonts, components and the branding rules
render.yaml           Render deployment blueprint
```

## Notes for local development

- If you only need to tweak `public/index.html`/`styles.css` and don't need the backend, you can serve the `public/` folder directly with `npx live-server public` for auto-reload on save. Anything that calls `/api/...` (login, applying, paying, tracking) needs the real server — use `npm start` and open port 3000 for that.
- `.env` and `node_modules/` are git-ignored; never commit real credentials.
