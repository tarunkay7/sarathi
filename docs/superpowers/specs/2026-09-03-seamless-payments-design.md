# Seamless Payments — Design

**Date:** 2026-09-03
**Status:** Approved for planning
**Supersedes:** the mock payment flow in `routes/payments.js` and the instant challan clear in `routes/challans.js`

## Goal

A citizen pays a licence fee or a pending challan in two taps, through a real Razorpay checkout popup, and the payment is confirmed by a signed webhook rather than by their browser.

## Why this is not cosmetic

The current flow has the browser declare that money moved. `routes/payments.js:78` flips a payment to `paid` because the client asked it to. That is the same class of defect as the client-supplied fee removed in the payment fix: the server trusting a value only the client controls.

Replacing it with a webhook moves the authority to the party that actually knows — the payment processor — and makes one of this project's existing claims literally true instead of simulated. `public/app.js:551` already renders "Awaiting bank confirmation — Ns" against a hardcoded 4.2s `setTimeout`. After this change that interval is the real gap between the popup closing and the signed webhook landing, and the citizen may close the tab during it without losing their payment.

## Global Constraints

- **Razorpay test mode only, permanently.** Live keys require business KYC and would mean collecting real money for simulated government fees. Test mode provides an identical popup and flow.
- **The amount is always derived server-side** from the application's service fee or the challan's `amount_cents`. It is never read from the request body.
- **The browser can never move a payment to `paid`.** Only a signature-verified webhook, or a server-initiated reconcile against Razorpay's API, may do so.
- **`DATABASE_URL` is a live production Neon instance shared by the Pi and Render deployments and holds data under judging.** No `DROP TABLE`, `TRUNCATE`, `DELETE`, or unguarded `UPDATE`. Schema changes are additive and idempotent; `db/schema.sql` is re-run on every deploy.
- **Tests never touch the database.** Domain logic is extracted as pure functions and tested with fixtures, following `computeAttention` in `routes/attention.js`.
- **`.env` is gitignored and must never be committed.** Keys are set on the Pi and Render out of band.
- Webhook signature verification runs over the **raw request body**.

## Verified account state (2026-09-03)

- Credentials valid; order creation confirmed (`order_TXc1I6DUfoKAhk`, 40000 paise, status `created`).
- Webhook registered and active at `https://sarathi.heytarun.com/api/payments/webhook`, secret set.
- All 38 event types are subscribed. Two consequences:
  - `payment.authorized` fires alongside `payment.captured`. **Key on `payment.captured` only** — `authorized` precedes capture.
  - The endpoint receives dispute, settlement, and rewards events it does not handle. It must **200-ack unhandled event types** so Razorpay stops retrying them.
- The webhook URL resolves through the existing Cloudflare Tunnel, so deliveries reach the Pi. Because the Pi and Render share one database, a delivery to the Pi also confirms payments for demos served from Render.

## Data model

One ledger for all money. The `payments` table was already shaped for this — `reconciling`, `failed`, and `refund_in_progress` exist in its status CHECK and `bank_ref` was unused — so this generalizes it rather than adding a parallel table.

```sql
ALTER TABLE payments ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN method         DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS challan_id     INTEGER REFERENCES challans(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS psp_order_id   TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS psp_payment_id TEXT;

DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_one_payable
    CHECK ((application_id IS NULL) <> (challan_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP INDEX IF EXISTS payments_one_live_per_application;
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_live_per_application ON payments (application_id)
  WHERE application_id IS NOT NULL AND status IN ('reconciling','paid');
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_live_per_challan ON payments (challan_id)
  WHERE challan_id IS NOT NULL AND status IN ('reconciling','paid');
CREATE UNIQUE INDEX IF NOT EXISTS payments_psp_order ON payments (psp_order_id)
  WHERE psp_order_id IS NOT NULL;
```

Notes on each non-obvious line:

- `method DROP NOT NULL` — at order-creation time the method is unknown. Razorpay reports it (`upi`, `card`, `netbanking`) on capture. Without this the insert fails.
- The `DO $$` wrapper exists because `ADD CONSTRAINT` has no `IF NOT EXISTS`, and `schema.sql` is re-run on every deploy. Unwrapped, the second `npm run db:migrate` fails.
- `payments_psp_order` makes webhook replay safe. Razorpay retries deliveries; a unique order id means a replay cannot create a second payment row.
- Verified safe against live data: 5 existing rows, all with `application_id` set, so the new CHECK validates without a rewrite.

## Payment lifecycle

```
  create order ──► reconciling ──► paid      (payment.captured webhook, or reconcile)
                        │
                        └────────► failed    (payment.failed webhook, or modal dismissal)
```

`reconciling` is the only live state before resolution, and the partial unique indexes make it exclusive per payable — a second tap returns the payment already in flight instead of starting another.

### Two defects this closes

**Dismissal leaves a permanently stuck payable.** Nothing in the current codebase ever sets `failed`. Under the mock that is invisible because confirm succeeds within a second, but once payments can genuinely fail — popup dismissed, card declined, UPI timeout — the row sits in `reconciling`, the partial unique index holds, and the citizen can never pay again. Razorpay's `modal.ondismiss` therefore reports to the server, which marks the row `failed` and frees the index.

**A lost webhook would hang forever.** Rather than a scheduled job, the existing status poll self-heals: when a poll finds a row still `reconciling` more than 8 seconds after its `created_at`, the server fetches that order's payments from Razorpay's API and resolves the row from Razorpay's answer. No scheduler, and the poll does real work instead of spinning.

The reconcile writes through the same pure `applyPaymentEvent` used by the webhook, so a webhook and a reconcile racing on one row converge on the same status rather than fighting.

## Trust boundary

`POST /api/payments/webhook` is mounted with `express.raw({ type: 'application/json' })` **before** the global `express.json()` at `server.js:16`. Razorpay signs the raw bytes; once `express.json()` has parsed and discarded them, re-serializing yields different bytes and every signature check fails. This is the most common Razorpay integration failure and the current middleware order pre-loads it.

Verification is HMAC-SHA256 over the raw body against `RAZORPAY_WEBHOOK_SECRET`, compared with `crypto.timingSafeEqual`. A request failing verification receives 400 and changes nothing. Handled events are `payment.captured` and `payment.failed`; every other type is acknowledged with 200 and ignored.

`POST /api/payments/:id/confirm` is **deleted**. It exists only to let the browser assert payment, which is precisely what this design removes.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/payments/order` | Body `{applicationId}` or `{challanId}`. Derives amount server-side, creates a Razorpay order, inserts `reconciling`, returns order id and `RAZORPAY_KEY_ID`. Idempotent: returns the in-flight payment if one exists. |
| GET | `/api/payments/:id` | Status poll. Reconciles against Razorpay if `reconciling` for over 8s. |
| POST | `/api/payments/:id/dismissed` | Popup closed without paying. Marks `failed` only if still `reconciling`. |
| POST | `/api/payments/webhook` | Signature-verified. Raw body. The only path to `paid`. |

`POST /api/challans/:id/pay` is **deleted**. A challan is paid by posting `{challanId}` to `/api/payments/order` like any other payable, so there is exactly one code path that creates an order and exactly one that reaches `paid`. Leaving both endpoints would give challans a second, divergent route to settlement — the asymmetry this design exists to remove.

## Files

- `routes/psp.js` (new) — Razorpay HTTP: order creation, signature verification, payment fetch. No database, no Express, no domain knowledge.
- `routes/payment-events.js` (new) — pure `applyPaymentEvent({ payment, event })` returning the next status and what it implies. Tested without Postgres.
- `routes/payments.js` — order, poll-with-reconcile, dismissal, webhook. `confirm` removed.
- `routes/challans.js` — `/pay` routes through a payment.
- `routes/attention.js` — `computeAttention` gains a `payments` input. A challan with a `reconciling` payment against it keeps its existing title but drops to severity `soon` with the detail "Payment received, confirming with your bank" and no action button, so the citizen is not invited to pay twice while their first payment is still resolving. The challan itself stays `pending`, so the application blocker at `routes/applications.js:123` correctly continues to block until the webhook lands.
- `public/app.js` — checkout launch, dismissal reporting, status poll. `processPayment` and `runPayment` replaced.
- `public/index.html` — checkout script tag; pay button on the intake summary; payment page and method radios removed; disclaimer at line 723 rewritten.
- `public/styles.css` — summary pay panel.
- `server.js` — raw-body webhook mount ahead of `express.json()`.
- `db/schema.sql` — the migration above, appended.
- `test/payment-events.test.js` (new).

## UI

The interstitial payment page is removed. The intake summary already shows the fee before any payment, so it carries a single `Pay ₹400 securely` button that opens Razorpay directly — two taps rather than three. The "you cannot be charged twice" reassurance moves onto that panel; it is now backed by the partial unique indexes rather than by a claim.

Our three method radios are deleted. Razorpay's popup asks the same question, and keeping ours risks a stored method that disagrees with what the citizen actually paid with. `payments.method` is populated from Razorpay's report.

After the popup closes the existing "Awaiting bank confirmation — Ns" display is reused verbatim, now driven by real reconciliation.

## Error handling

| Case | Behaviour |
|---|---|
| Popup dismissed | Payment marked `failed`; the citizen may retry immediately. |
| `payment.failed` webhook | Marked `failed`; on-screen reason; retry available. |
| Webhook lost | Poll after 8s reconciles against Razorpay's API. |
| Webhook replayed | `payments_psp_order` unique index makes it a no-op. |
| Bad signature | 400, nothing mutated, logged. |
| Unhandled event type | 200, ignored. |
| Razorpay unreachable at order creation | 502 with a retry message; no payment row created. |
| Second tap while `reconciling` | Returns the in-flight payment. |

## Testing

`test/payment-events.test.js` covers `applyPaymentEvent` with fixtures and no database: capture on a `reconciling` row, capture replayed on a `paid` row, failure on `reconciling`, dismissal, an event arriving for an already-`failed` row, and an unhandled event type. Signature verification is tested against a known-good HMAC computed in the test.

Manual verification uses Razorpay's test UPI VPA `success@razorpay` for the success path and `failure@razorpay` for the failure path.

## Out of scope

Refunds (despite `refund_in_progress` existing in the status CHECK), saved cards, partial payments, multiple currencies, and any scheduled job.

## Consequences accepted

1. **`POST /:id/confirm` is deleted.** `public/app.js:534` calls it today. This is the point of the change, not a side effect.
2. **Challan payment stops being instant.** It gains a genuine 1–3s reconcile. Slower on camera, but true.
3. **`pay-delay-demo` is deleted.** A simulated delay beside a real one is a fiction the real thing already demonstrates honestly.
4. **The disclaimer at `public/index.html:723` becomes false and must be rewritten.** It currently reads "No real government official, system, OTP, or payment gateway is referenced or contacted." Payments will run against Razorpay's sandbox, so it must say so.
