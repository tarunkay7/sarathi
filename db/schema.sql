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
