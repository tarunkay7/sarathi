# Database schema

Postgres (hosted on Neon). Defined in `schema.sql`, applied via `npm run db:migrate`, seeded via `npm run db:seed`.

## Tables

### `citizens`
One row per logged-in citizen (created on first OTP verification — there's no separate registration step).

| column | type | notes |
|---|---|---|
| `id` | serial, PK | |
| `mobile_number` | varchar(10), unique | login identity |
| `name` | text | mock demo data |
| `dob` | date | used for Form 1A eligibility |
| `state`, `rto` | text | citizen's home RTO |
| `dl_number` | text | existing licence, if any |
| `aadhaar_kyc_verified` | boolean | mock — always true in this prototype |
| `created_at` | timestamptz | |

### `services`
Reference/config table, one row per licence service. Seeded once by `db/seed.js`, not written to at runtime.

| column | type | notes |
|---|---|---|
| `key` | text, PK | `renew`, `new`, `duplicate`, or `address` |
| `title` | text | display name |
| `form_number` | text | e.g. "Form 9" |
| `fee_cents` | integer | fee in paise |
| `requires_slot` | boolean | whether an RTO visit/slot applies |
| `expected_days` | integer | used to compute `applications.expected_by` |
| `checklist` | jsonb | array of `{ label, badge? }` shown on the intake screen |
| `eligibility` | jsonb | e.g. `{ "form1aMinAge": 40 }` |

### `applications`
One row per service application a citizen starts.

| column | type | notes |
|---|---|---|
| `id` | serial, PK | |
| `reference_code` | text, unique | shown to the citizen throughout (e.g. `TS-DL-2026-4821`) |
| `citizen_id` | integer, FK → `citizens.id` | |
| `service_key` | text, FK → `services.key` | |
| `status` | text | `details` → `paid` → `under_review` → `approved` → `ready` |
| `expected_by` | date | `created_at` + `services.expected_days` |
| `escalated`, `escalated_at` | boolean, timestamptz | set by the "stuck application" auto-escalation demo |
| `slot_at`, `slot_location` | timestamptz, text | only meaningful when the service requires a slot |
| `created_at` | timestamptz | |

### `payments`
One row per payment attempt against an application. An application can have more than one row here (e.g. a failed attempt followed by a retry).

| column | type | notes |
|---|---|---|
| `id` | serial, PK | |
| `application_id` | integer, FK → `applications.id` | |
| `amount_cents` | integer | |
| `method` | text | `UPI`, `Card`, or `Net banking` |
| `status` | text | `pending` → `reconciling` → `paid` (or `refund_in_progress` / `failed`) |
| `bank_ref` | text | the payment gateway's own payment id (`pay_…`), set when a payment is captured |
| `created_at`, `confirmed_at` | timestamptz | |

### `timeline_events`
Append-only log of what happened to an application, shown on the track screen. One row per event (submitted, payment confirmed, escalated, etc.).

| column | type | notes |
|---|---|---|
| `id` | serial, PK | |
| `application_id` | integer, FK → `applications.id` | |
| `label` | text | human-readable event description |
| `occurred_at` | timestamptz | |

## Relationships

```
citizens (1) ──< (many) applications
services (1) ──< (many) applications      [applications.service_key → services.key]
applications (1) ──< (many) payments
applications (1) ──< (many) timeline_events
```

A citizen can have many applications (one per service they've started). Each application belongs to exactly one service definition, can accumulate multiple payment attempts, and has an append-only timeline of events.

## Not yet modelled

- Grievances/support tickets — planned but not yet built (see the project plan).
- The "My Documents" DL/RC records shown on the dashboard are still static mock content, not backed by a table.
