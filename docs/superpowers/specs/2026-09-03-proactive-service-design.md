# The service comes to you — design

**Status:** approved, not yet implemented
**Target:** Build What Moves India, Phase 2 submission, 7 September 2026
**Budget:** 15–25 hours across two people

## Why

Sarathi's two headline problems — money deducted but shown as failed (40% of
complaints) and applications frozen with no explanation (33%) — are both
symptoms of one thing. They are what a **reactive** service feels like: you only
discover the problem by going to look, and when you look, it is silent.

Every licence service worth copying is proactive. Dubai's RTA tells you before
renewal is due and refuses to let an unpaid fine surprise you at the counter.
Estonia mandates in law that the state may not ask for data it already holds.
Singapore bundles services around a life event rather than a department. The
common posture is that the service contacts the citizen, not the reverse.

Sarathi waits. Everything it knows, it knows silently until someone opens the
page and asks.

It already has one piece of proactive behaviour — an application past its
expected date auto-escalates without the citizen doing anything — but it is
buried and unnamed.

This design makes the posture explicit, and connects it to the grievance work:

> Most grievances exist because nobody told you anything. The best grievance
> channel is the one you never need to open.

## What we are building

Three changes that share one principle: **the system may only tell you things it
can point at.**

1. A computed *Needs your attention* surface on the dashboard.
2. A pending-challan check that blocks renewal, with a way to clear it.
3. Grievance answers grounded in the service rules the app already encodes.

## Scope

### In

- `citizens.dl_expires_on` — a real licence expiry, replacing a hardcoded value.
- `challans` table, seeded, with a pending-challan blocker on renewal and a way
  to pay it off.
- `GET /api/attention/citizen/:id` — a computed attention list, never stored.
- A dashboard panel rendering that list, including a deliberate empty state.
- Service rules added to the grievance fact sheet, plus a `source` on the triage
  output and a rule forbidding unsourced answers.
- Fixing two remaining hardcoded claims: "Valid till 02 Sep 2026" and the
  always-on "Renewal due" chip.

### Out

- Actually sending anything. No SMS, no push, no email.
- Any officer or admin interface. No officer ever replies; unchanged.
- An authentication layer. Still absent, still disclosed.
- A real e-Challan or VAHAN integration. Challans are seeded rows.

## Data model

```sql
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS dl_expires_on DATE;

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
```

`dl_expires_on` is nullable on purpose. The demo persona holds no licence, so the
attention surface has to behave correctly for a citizen with no expiry at all.

## The attention engine

`GET /api/attention/citizen/:id` returns a list computed from current state and
never persisted, so it cannot go stale.

Each item carries: `kind`, `severity` (`act` / `soon` / `info`), `title`,
`detail`, an optional `action`, and a `source` naming the record or rule it came
from.

| Kind | Trigger | Severity | Source cited |
|---|---|---|---|
| `challan_pending` | Any challan with status `pending` | act | The challan row |
| `payment_incomplete` | Application with no payment in `('reconciling','paid')` | act | The application row |
| `overdue` | Past `expected_by` | act | Service `expected_days` |
| `licence_expired` | `dl_expires_on` in the past | act | Renewal window rule |
| `licence_expiring` | `dl_expires_on` within 60 days | soon | Renewal window rule |
| `appointment_soon` | `slot_at` within 3 days | soon | Service `carry_items` |
| `document_missing` | Required upload absent on an in-progress application | soon | Service checklist |
| `will_block` | Form 1A required by age or vehicle class | info | Service `eligibility` |

Ordering is by severity, then by date. `act` items always sort above `soon`.

## The challan blocker

Three consequences, in order of importance:

1. **Enforced server-side.** `POST /api/applications` refuses `serviceKey`
   `renew` and `dl` while the citizen has a pending challan, and the error names
   the challan and the amount. In the route, not the UI — the same discipline as
   the server-derived fee and the required vehicle class.

   Blocking `dl` as well as `renew` is both defensible and necessary. Defensible
   because both issue or extend a licence, whereas `duplicate` merely replaces a
   document already held and `new` is a first learner's licence. Necessary
   because the demo persona holds no licence and applies for `dl` — if the block
   covered `renew` alone, the video would have to switch accounts mid-demo to
   show the feature at all.
2. **Surfaced before it bites.** The attention panel shows it, and the intake
   screen shows it before payment rather than at the counter.
3. **Clearable.** `POST /api/challans/:id/pay` settles it, the block lifts, and
   the application proceeds.

   This does **not** go through the `payments` table. That table requires an
   `application_id`, and a challan is not attached to an application. It is a
   guarded status change instead — `UPDATE challans SET status = 'paid',
   paid_at = now() WHERE id = $1 AND status = 'pending'` — which is idempotent
   by construction: a second call matches no rows and changes nothing.

That third point is not optional. Without it the demo dead-ends: you show the
block and can never get past it. With it, the sequence is
**blocked → told exactly why → clear it → through**, which is both Dubai's
actual behaviour and the strongest sixty seconds available.

**Legal caveat.** Linking pending challans to licence services exists in practice
across several Indian states through VAHAN and e-Challan, but the exact scope
varies by state and is not verified here. Present it as the rule this prototype
implements, never as settled national law.

## Grievance grounding

The fact sheet currently contains the citizen's rows and nothing else, which is
why testing produced the reply *"You can bring a digital copy of your old
licence"* — plausible, and with no basis anywhere in the system.

Three changes:

- The fact sheet gains the service rules already in the `services` table: fees,
  form numbers, expected days, prerequisites, carry items, the Form 1A age
  threshold, and the pincode-to-RTO jurisdiction rule.
- The triage schema gains `source`, naming what the answer was drawn from.
- The system prompt gains a hard rule: if the answer is not in the citizen's
  records or the service rules, the model may not answer — it must route to a
  human.

Because the rules come from the same table the application flow reads, there is
no parallel knowledge base to drift out of sync.

## UI

A new panel at the top of the dashboard's main column, above the licence cards.
A proactive service leads with what needs doing, not with your documents.

```
┌─ Needs your attention ─────────────────── 2 items ─┐
│  ● Act now    ₹1,000 challan pending                │
│               Signal violation, 12 Aug 2026.        │
│               This blocks your renewal.             │
│               Because: challan CH-2026-8841         │
│                                     [ Pay ₹1,000 ]  │
│  ─────────────────────────────────────────────────  │
│  ● Soon       Your licence expires in 24 days       │
│               Renew now and it stays valid with no  │
│               gap.                                  │
│               Because: renewal opens 1 year before  │
│               expiry                  [ Renew now ] │
│                                                     │
│  In a live service these would reach you by SMS.    │
│  This prototype computes them when you open the     │
│  page and sends nothing.                            │
└─────────────────────────────────────────────────────┘
```

- Severity colours come from the existing palette: `#A3402E` act, `#D98A2B`
  soon, `#22315C` info. Every row carries a text severity label as well, since
  nothing in this codebase relies on colour alone.
- **The panel does not hide when empty.** It reads *"Nothing needs your
  attention. We'll tell you when it does."* That sentence is the posture stated
  outright, and hiding the panel would throw it away.
- The `Because:` line is on every row. It is the visible proof of the grounding
  principle and the reason a reader can trust the rest.
- Built from the existing `.panel` / `.panel-head` components with a count in
  `.sub`, matching Active Applications and Your grievances, so it reads as part
  of the dashboard rather than bolted on. Rows stack under 560px with the action
  dropping below the text.

## Testing

The attention engine is pure computation over rows, so it tests directly: seed a
state, assert the items.

- Each kind fires on its trigger and not otherwise.
- Ordering puts `act` above `soon`.
- A citizen with no licence produces no expiry item and does not error.
- The empty case returns an empty list, and the panel still renders.
- `renew` and `dl` are refused while a challan is pending, and permitted once it
  is paid. `duplicate` and `new` are never blocked.
- Paying the same challan twice settles it once. The existing
  `payments_one_live_per_application` index does **not** cover this, because a
  challan has no application; the guard is the `AND status = 'pending'` clause.
- A grievance asking something with no source routes to a human rather than
  being answered.
- The multilingual behaviour still holds after the fact sheet grows: Hindi,
  Telugu and Tamil replies in their own script, English summary intact.

## Risks

**Scope.** These three pieces sit at the top of the 15–25 hour band. If it runs
long, **defer the grievance grounding** — the attention surface and the challan
blocker are the story; grounding is the invisible virtue. Decide this by day
five, not day eight.

**Demo data.** The attention panel is only impressive with a citizen in an
interesting state, and the demo persona is awkward here: Tarun holds no licence,
so he can never show the expiring-licence item. The seed therefore needs to
carry both shapes — Tarun with a pending challan and no expiry, and a
licence-holding citizen with an expiry inside 60 days — and the video has to
choose which story it tells. Reset the account before recording either way.

**Over-claiming.** Every item added to this panel must come from a real row or a
real rule. The moment one is hardcoded to look good, the `Because:` line becomes
a lie and the whole feature stops being worth anything.

## Not doing, and why it matters

No fines integration beyond seeded rows, no officer side, no auth layer, nothing
actually sent. Each is disclosed in the UI rather than hidden.

The absences are part of the argument. A service that tells you what it knows
should also be able to tell you what it does not.
