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
