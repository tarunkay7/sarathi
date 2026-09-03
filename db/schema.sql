CREATE TABLE IF NOT EXISTS citizens (
  id SERIAL PRIMARY KEY,
  mobile_number VARCHAR(10) UNIQUE NOT NULL,
  name TEXT NOT NULL,
  dob DATE,
  state TEXT,
  rto TEXT,
  dl_number TEXT,
  aadhaar_kyc_verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE citizens ADD COLUMN IF NOT EXISTS vehicle_classes TEXT NOT NULL DEFAULT 'LMV, MCWG';
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS email TEXT;
-- What an RTO visit is for, and what to bring, differ per service: a renewal
-- captures photo/biometrics, a new learner's licence is the computerised test.
-- These were hardcoded to the renewal case in the UI.
ALTER TABLE services ADD COLUMN IF NOT EXISTS slot_purpose TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS carry_items TEXT;
-- A rule the citizen must already satisfy before applying at all, as opposed to
-- a document they bring. Surfaced up front rather than discovered at the RTO.
ALTER TABLE services ADD COLUMN IF NOT EXISTS prerequisite_note TEXT;

-- Address of record comes from Aadhaar eKYC and is what decides which RTO has
-- jurisdiction — see the rto_pincodes note below.
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS pincode VARCHAR(6);

CREATE TABLE IF NOT EXISTS services (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  form_number TEXT,
  fee_cents INTEGER NOT NULL,
  requires_slot BOOLEAN NOT NULL DEFAULT TRUE,
  expected_days INTEGER NOT NULL DEFAULT 4,
  checklist JSONB NOT NULL DEFAULT '[]',
  eligibility JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  reference_code TEXT UNIQUE NOT NULL,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  service_key TEXT NOT NULL REFERENCES services(key),
  status TEXT NOT NULL DEFAULT 'details'
    CHECK (status IN ('details','paid','under_review','approved')),
  expected_by DATE,
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  escalated_at TIMESTAMPTZ,
  slot_at TIMESTAMPTZ,
  slot_location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 'ready' was dropped from the status flow; approved is now the final stage.
-- The CREATE above is skipped on existing databases, so restate the constraint.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
  CHECK (status IN ('details','paid','under_review','approved'));

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reconciling','paid','refund_in_progress','failed')),
  bank_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  label TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- map_query is the search string handed to Google Maps rather than a verified
-- street address, so the pin resolves without us asserting coordinates we
-- have not confirmed. address/hours stay nullable until they are.
CREATE TABLE IF NOT EXISTS rtos (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  city TEXT,
  map_query TEXT NOT NULL,
  address TEXT,
  hours TEXT,
  UNIQUE (name, state)
);

-- Which RTO can process an application is set by where the applicant
-- ordinarily resides or carries on business (Motor Vehicles Act 1988, s.8 for
-- learner's licences) — NOT by device location, which would route a Hyderabad
-- resident travelling in Delhi to an authority that must reject them. So the
-- lookup is keyed on the eKYC address pincode; one pincode sits under exactly
-- one jurisdiction, hence pincode as the primary key.
CREATE TABLE IF NOT EXISTS rto_pincodes (
  pincode VARCHAR(6) PRIMARY KEY,
  rto_id INTEGER NOT NULL REFERENCES rtos(id) ON DELETE CASCADE
);

-- Content lives in the row rather than on disk: Render's free tier has an
-- ephemeral filesystem, so uploads written there vanish on every redeploy.
-- Files are small (a signature scan or a one-page Form 1A), so BYTEA is a fair
-- trade for surviving restarts without adding object storage.
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content BYTEA NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One current file per kind per application; re-uploading replaces it.
  UNIQUE (application_id, kind)
);

-- A citizen who retries a payment that the bank is slow to confirm must not be
-- charged a second time. The UI disables the pay button while a charge is in
-- flight, but a refresh, the back button, or a dropped connection all defeat
-- that, so the guarantee is enforced here instead: at most one live payment per
-- application. 'failed' and 'refund_in_progress' rows sit outside the predicate
-- so a genuine retry after a real failure is still allowed.
--
-- Any duplicates already recorded would block the index, so supersede them
-- first — keep the settled row if there is one, otherwise the earliest attempt,
-- and mark the rest failed rather than deleting the audit trail. This is a
-- no-op once the index exists, because the index prevents new duplicates.
UPDATE payments SET status = 'failed'
WHERE status IN ('reconciling','paid')
  AND id NOT IN (
    SELECT DISTINCT ON (application_id) id
    FROM payments
    WHERE status IN ('reconciling','paid')
    ORDER BY application_id, (status = 'paid') DESC, id
  );

CREATE UNIQUE INDEX IF NOT EXISTS payments_one_live_per_application
  ON payments (application_id)
  WHERE status IN ('reconciling','paid');

-- Grievances. The current portal makes the citizen pick a category and a
-- subject line before it will accept the complaint, which is why so much of it
-- lands in the wrong queue; here they write in their own words and the triage
-- assigns the category. answered_immediately marks the ones that never needed a
-- queue at all — most "where is my licence" tickets are answerable from the
-- application row the citizen is already looking at.
-- triaged_by records whether the model or the keyword fallback classified it, so
-- the UI can be honest about which one the citizen is reading.
CREATE TABLE IF NOT EXISTS grievances (
  id SERIAL PRIMARY KEY,
  ticket_code TEXT UNIQUE NOT NULL,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  -- Nullable: a grievance can be about the service in general rather than one
  -- application. SET NULL so deleting an application never destroys the ticket.
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal'
    CHECK (severity IN ('low','normal','high')),
  summary TEXT,
  route_to TEXT,
  citizen_reply TEXT,
  answered_immediately BOOLEAN NOT NULL DEFAULT FALSE,
  triaged_by TEXT NOT NULL DEFAULT 'rules'
    CHECK (triaged_by IN ('openai','rules')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','answered','in_progress','closed')),
  expected_by DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grievances_citizen_idx ON grievances (citizen_id, id DESC);

-- A permanent driving licence can only be applied for on the strength of a
-- learner's licence, so the number is part of the application rather than
-- something checked once and forgotten. Nullable: no other service needs it.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS learner_licence_number TEXT;

-- A citizen who holds no licence holds no vehicle classes either. The column
-- defaulted every new account to 'LMV, MCWG', which the intake screen then
-- displayed back as fact — the same overclaim as asserting Aadhaar KYC. Signup
-- records none, so the column has to allow it.
ALTER TABLE citizens ALTER COLUMN vehicle_classes DROP NOT NULL;
ALTER TABLE citizens ALTER COLUMN vehicle_classes DROP DEFAULT;

-- What the citizen is applying FOR, which is not what they already hold. The
-- class also decides whether a medical certificate is needed, so it has to be
-- answered before the application exists rather than assumed from the account.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_classes TEXT;

-- The language the citizen actually used. Whisper was translating every
-- complaint to English before anything saw it, which meant the reply could only
-- ever come back in English — the system listened in Telugu and answered in a
-- language the citizen might not read. Stored so the reply, and the citizen's
-- own words shown back to them, stay in their language while the officer's
-- summary stays English.
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS language TEXT;

-- A licence has an expiry, and a proactive service is built around it. The
-- dashboard was showing a hardcoded date, which is the one number this whole
-- feature depends on. Nullable: an account that holds no licence has no expiry.
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS dl_expires_on DATE;

-- Seeded, not fetched. A real deployment would read these from e-Challan or
-- VAHAN; this prototype stores them so the blocker has something real to point
-- at rather than the model inventing a fine.
CREATE TABLE IF NOT EXISTS challans (
  id SERIAL PRIMARY KEY,
  challan_number TEXT UNIQUE NOT NULL,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  offence TEXT NOT NULL,
  location TEXT,
  issued_on DATE NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid')),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS challans_citizen_idx ON challans (citizen_id, status);

-- What the triage answer was grounded in — a reference code or a named service
-- rule, or "none" when it had neither and had to route to a human instead of
-- guessing. Nullable-by-default TEXT so old rows (triaged before this column
-- existed) simply have no source recorded.
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS source TEXT;
