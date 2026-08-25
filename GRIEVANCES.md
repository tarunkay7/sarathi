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
| **Documents** | Uploads rejected, forms unclear, what to bring | "Do I need to bring my old licence to the office, or is the digital copy enough?" |
| **Error on licence** | Wrong name, spelling, address or class on an issued licence | "My licence came with my father's name spelled wrong. How do I get it corrected?" |
| **Staff conduct** | Bribes, agents demanding money, rude or obstructive behaviour | "An agent outside the office told me to pay him ₹2000 extra or my file will not move." |
| **General** | Anything else, including plain questions | "Can I renew my licence from a different city if I have moved?" |

You can optionally tag the grievance to one of your applications. If you do, it
also appears in that application's timeline.

**Length:** between 10 and 2000 characters.

## What happens when you submit

One of two things:

**Answered straight away** — your question was already answerable from your own
application record, so nothing is queued and no officer is involved. The reply
quotes your real reference number and dates. Most "where is my application" and
"when will it be ready" grievances end here.

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
  the reply, grounded only in that citizen's own application rows.
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

`POST /api/grievances` builds a fact sheet from the citizen's own applications —
reference codes, statuses, expected dates, escalation flags, payment state — and
sends it with the complaint to OpenAI Chat Completions using a `strict`
`json_schema`. Because the schema is strict, the response always parses and the
category is always one the router knows.

The model is told to use only the facts given and never to invent a reference
code, date, amount, officer or office. Asked about an application that does not
exist, it attributes the claim to the citizen and routes it to a human rather
than confirming it.

Category and severity are what the model decides. The desk and the reply date are
derived from those server-side, so the model cannot invent a destination or a
deadline.

**If OpenAI is unavailable** — no key, or the call fails — the grievance is still
accepted and routed by keyword matching. A grievance is never lost because a
third party was down. Every card says which one sorted it: *"Sorted by AI
triage"* or *"Sorted by keyword fallback"*.

## API

```
POST /api/grievances
  { citizenId, applicationId?, body }
  -> 201 { grievance }
  400 if body is under 10 or over 2000 characters,
      or applicationId is not on that citizen's account

GET /api/grievances/citizen/:id
  -> 200 { grievances: [...] }   newest first
```

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | No | Without it, triage falls back to keywords. Also powers the voice assistant. |
| `OPENAI_TRIAGE_MODEL` | No | Defaults to `gpt-4o-mini`. |
