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
    CHECK (status IN ('details','paid','under_review','approved','ready')),
  expected_by DATE,
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  escalated_at TIMESTAMPTZ,
  slot_at TIMESTAMPTZ,
  slot_location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
