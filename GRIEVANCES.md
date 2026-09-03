# Grievances

A citizen describes a problem in their own words. The system reads it, works out
what kind of problem it is, and either answers it on the spot or sends it to the
desk that owns it.

**The problem this replaces:** the current portal makes you choose a category and
write a subject line before it will accept your complaint. Most people guess, so
the complaint lands in the wrong queue, and nothing comes back. There is no
category to choose here.

## What you can raise

Write plainly. You do not pick the category — the triage assigns it.

| Category | What it covers | Example of what to write |
|---|---|---|
| **Payment** | Money taken and unaccounted for, double charges, refunds not received | "The money was cut from my account twice for the same renewal fee. I want the extra amount back." |
| **Delay** | No update, missed expected date, nobody answering | "It has been three weeks since I applied and there is still no update. Nobody picks up the phone at the office." |
| **Appointment** | Slot cancelled, cannot book, wrong date, test rescheduling | "My appointment was cancelled without telling me and now I cannot book another date." |
| **Documents** | Uploads rejected, forms unclear, what to bring | "What do I need to carry to the office for my appointment?" |
| **Error on licence** | Wrong name, spelling, address or class on an issued licence | "My licence came with my father's name spelled wrong. How do I get it corrected?" |
| **Staff conduct** | Bribes, agents demanding money, rude or obstructive behaviour | "An agent outside the office told me to pay him ₹2000 extra or my file will not move." |
| **General** | Anything else, including plain questions | "Can I renew my licence from a different city if I have moved?" |

You can optionally tag the grievance to one of your applications. If you do, it
also appears in that application's timeline.

**Length:** between 10 and 2000 characters.

## What happens when you submit

One of two things:

**Answered straight away** — your question was already answerable from your own
application rows or from a service rule the system holds, so nothing is queued
and no officer is involved. The reply quotes your real reference number and
dates, and the card names what it was drawn from. Most "where is my
application", "when will it be ready" and "what is the fee" grievances end here.

> Your driving licence renewal application TS-DL-2026-3197 was submitted on
> 2026-08-23 and is expected to be ready by 2026-08-26. It seems there is no
> payment recorded yet.

**Logged and routed** — it needs a human. You get a ticket number, the desk it
went to, and a date by which you will hear back.

| Category | Goes to |
|---|---|
| Payment | RTO accounts desk |
| Delay | RTO application desk |
| Appointment | RTO appointment desk |
| Documents | RTO verification desk |
| Error on licence | RTO records desk |
| Staff conduct | RTO grievance officer |
| General | RTO help desk |

## How fast you get a reply

Severity sets the deadline. It is assigned by the triage, not chosen by you.

| Severity | When it applies | Reply due within |
|---|---|---|
| **High** | Money has left your account and is unaccounted for; a bribe or extortion; a licence already issued with wrong details; a missed legal deadline | 2 working days |
| **Normal** | Everything else | 5 working days |
| **Low** | General questions where nothing is at stake | 7 working days |

High-severity tickets are marked **Urgent** on the dashboard.

## Where it appears

- **Raise a grievance** — right-hand sidebar of the dashboard, under the services
  list. The form, and the outcome of whatever you just submitted.
- **Your grievances** — main column, directly under Active Applications. Every
  ticket you have raised, with your original words, the reply, where it went and
  when a reply is due. Hidden entirely when you have none.

## What is real and what is mocked

Real:

- The triage. An OpenAI model classifies the complaint, sets severity, and writes
  the reply, grounded in that citizen's own application rows and in the service
  rules the system holds — and in nothing else.
- The grounding check. Whether an answer counts as grounded is decided by the
  server, not by the model, and a source the server does not recognise is
  refused. See *How the triage works* below.
- `source` — the record or rule each answer was drawn from, stored on the ticket
  and shown on the card. `none` when nothing was cited.
- Persistence. Tickets are stored in Postgres and survive restarts.
- Routing and reply dates, computed server-side from category and severity.
- The timeline entry written onto a linked application.

Mocked or absent:

- **No officer ever replies.** Tickets sit at `open` forever. There is no admin
  panel, by design — reviewers test the citizen experience.
- **Statuses `in_progress` and `closed` are unreachable.** The schema allows them
  so the flow is complete on paper, but nothing advances a ticket into them.
- **No SMS or email is sent.** The confirmation text is illustrative.
- The desks are labels, not real offices. No real government system is contacted.

## How the triage works

**The server decides whether an answer is grounded — the model only proposes.**
Every reply has to name a `source`, and the server checks that name against the
exact set of sources it built the fact sheet from. A name that is not in that
set — `none`, a vague phrase like "your application record", or a reference code
that does not exist — is refused. When it is refused the model's prose is
discarded and replaced with the fixed routing notice, the ticket is marked
unanswered, and `source` is stored as `none`. So an answer the server would not
stand behind cannot reach the citizen, whatever the model wrote, and the
"Answered from:" line under a reply is only ever a source the server itself
recognised. This is a structural check in `routes/grievances.js` (`isGrounded`),
covered by tests, not an instruction the model is trusted to follow.

Matching is exact after trimming and lowercasing, deliberately not a substring
match: the service keys are the single words `new`, `dl` and `renew`, so a looser
comparison would accept almost any sentence that mentioned a renewal. The cost
is a false negative — a model that writes "application TS-DL-2026-1200" instead
of the bare code is treated as ungrounded and its question goes to a human. That
is the direction chosen: an unanswered question is recoverable.

**What the fact sheet contains.** `POST /api/grievances` builds it from two
things and nothing else:

- The citizen's own applications — reference codes, service titles, statuses,
  fees, submission and expected dates, escalation flags, payment state.
- The service rules — title, form number, fee, expected days, whether an RTO
  visit is needed and what to carry, the prerequisite note, and the age
  threshold at which a Form 1A medical certificate is required.

It is sent with the complaint to OpenAI Chat Completions using a `strict`
`json_schema`, so the response always parses and the category is always one the
router knows.

The prompt also tells the model to use only those facts and never to invent a
reference code, date, amount, officer or office. That instruction shapes the
output; it does not enforce anything. The enforcement is the check above.

Category and severity are what the model decides. The desk and the reply date are
derived from those server-side, so the model cannot invent a destination or a
deadline.

**If OpenAI is unavailable** — no key, or the call fails — the grievance is still
accepted and routed by keyword matching. A grievance is never lost because a
third party was down. The keyword path never reads a fact sheet, so it never has
a source to name and never answers anything. Every card says which one sorted
it: *"Sorted by AI triage"* or *"Sorted by keyword fallback"*.

## How far the grounding check goes

Measured on this build, and stated here rather than left for a reviewer to
discover. What holds:

- Every answer names a source.
- The server rejects a source it was never shown.
- Unsourced answers are routed to a human.

What is left open:

- **Roughly a third of ungrounded compound questions still receive an answer
  citing a real but unsupporting record.** A question that bundles something the
  facts cover with something they do not — *"Do I need to bring my old licence
  to the office, or is the digital copy enough?"* is the canonical case, and the
  one the residual was measured on — can come back cited to a genuine reference
  code that says nothing about the part actually asked. The citation is real;
  the support is not. Verifying a claim's *content* against its source needs a
  second model call, which is out of scope here, so the check does not attempt
  it.
- **An ungrounded question asked in Hindi or Telugu gets an English reply.**
  Multilingual replies work everywhere else — the model answers in the language
  the citizen used, and the officer-facing summary stays English. But the
  routing notice that replaces a refused answer is one fixed English sentence,
  not a translation. The one case where a citizen most needs to understand what
  just happened is the one case they may not be able to read.

## API

```
POST /api/grievances
  { citizenId, mobileNumber?, applicationId?, body, language? }
  -> 201 { grievance }
  400 if body is under 10 or over 2000 characters,
      or applicationId is not on that citizen's account
  401 if neither the id nor the mobile number resolves to a citizen

GET /api/grievances/citizen/:id
  -> 200 { grievances: [...] }   newest first
```

Each `grievance` carries `source` alongside `citizen_reply` and
`answered_immediately`: the reference code or service rule the answer was drawn
from, or `none`. It is only ever a source the server accepted — a claimed source
the grounding check refused is stored as `none`, so the field can be rendered
directly without re-deriving whether the answer was grounded.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | No | Without it, triage falls back to keywords. |
| `OPENAI_TRIAGE_MODEL` | No | Defaults to `gpt-4o-mini`. |
