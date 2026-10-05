# Get Secure CRM: the plan for an autonomous CRM run by Hermes

Status: proposed, 5 October 2026. This supersedes `docs/PLAN.md` (the original build plan, kept
as history). Nothing in this document is built yet; it is the plan to agree before the next
development runs.

## 1. The goal, in Chris's words

Hermes is the top intelligence of the company. It reads every email and every Plaud recording and
acts on what it is confident about. Chris opens the CRM and sees what Hermes has done: an
indicative quote prepared for a three-camera enquiry, an appointment pencilled in, a reply drafted,
an Ajax alarm quote put together from the supplier's prices with product images. Each one says
"this is what I've done, do you want to send / confirm / change it?", and Chris approves or
rejects. When Hermes is stuck it asks Chris, and Chris's answer becomes something Hermes knows
from then on. Hermes is proactive, not only reactive: it looks at the whole business (accounts,
follow-ups, reviews, recurring revenue) and brings opportunities to Chris. The screens are
simpler, organised by what Chris needs to do, not by which subsystem produced it.

What does not change (the standing limits, enforced in code):
- Nothing reaches a customer or binds the company without Chris: no sending, confirming, pricing
  promises, discounts or accepting terms.
- The Business Brain owns technical and commercial truth; prices come only from approved trade
  costs; an unknown cost is never $0; research never silently becomes approved knowledge.
- Nobody is linked on a name alone; conflicting facts are flagged, never overwritten.
- Supplier logins stay encrypted and server-side; Hermes never sees a password, cookie or token;
  CAPTCHA or MFA stops a lookup; no secrets in the repo.
- Every write is audited and reversible where practical; no hidden reasoning is stored.

## 2. What the audit found

The audit covered the UI, the email and recording pipeline, and the quoting, supplier, booking and
accounting capabilities. The foundations are strong: the guardrail layer, the audit trail, the
CCTV Business Brain with real supplier pricing, the branded proposal PDF, the IT Plus connector,
Hermes's tools, the Titan mail and calendar sync. The problems are structural, and they are the
reason the Inspector feels cluttered and the system still second-guesses Hermes.

### 2.1 Two brains decide the same thing
An inbound email is classified by the old email classifier (Anthropic or rules, threshold 0.75)
which creates leads and flags "needs review", and then by Hermes (threshold 0.6) which can create,
propose, or reverse the same decision. The lead's fields (name, summary, next action) still come
from the old classifier's extraction, not from Hermes. The old deterministic reading (`extract`,
`analyse`, `plan`, ~700 lines) still runs twice per inspection for comparison and fallback, and
the Jev shadow classifier is a third opinion when switched on. Up to three model calls per email.

### 2.2 Thirteen places where things wait for Chris
Drafts (Approvals), quote approvals (Approvals), Hermes proposals (Inspector), Hermes reviews
(Inspector), email review (Inbox), fact conflicts (Inspector), Brain candidates (Settings),
package candidates (Settings), notifications (bell), tasks (Today, My day, Settings), commitments
(Today), recordings to file (Recordings), research findings (Settings). The same email can sit in
both the Inbox and the Inspector queues; some decisions clear one but not the other. Only two
queues have badges. Today shows quotes, tasks, leads and commitments that also appear on three
other pages each.

### 2.3 Several copies of the same mechanism
- Identity: four matchers (pipeline sender/thread match, recording phone match, Inspector
  signals, Hermes's suggestion), with duplicated phone and name helpers, and an inconsistency
  where a recording filed by phone is "attached" on one page and "unknown" in the Inspector.
- Follow-ups: automations rules, Inspector tasks, MCP tasks, commitments, `followUpAt`,
  `nextAction`, with no shared de-duplication; only automations tasks notify anyone.
- Drafts and tasks are created by both the router and Hermes's MCP tools with different
  de-duplication.
- Plaud sync runs only from cron or a button, not the worker loop; outbound email is effectively
  never inspected.

### 2.4 Quoting is CCTV-only, and nothing else can be quoted properly
- Only the CCTV Brain produces an approvable quote with the branded PDF. Alarm, access control
  and intercom enquiries become a "quote manually" task.
- The manual quote editor is free text (description, quantity, price): no catalogue products, no
  costs, no approval, no PDF.
- The catalogue has no alarm categories, no Ajax hub, sensors or keypads, no alarm kits or
  installation packages. Clear Digital exists as a supplier row with the Ajax route but no
  connector; the connector code hardcodes IT Plus. Imports never create products. Research cannot
  return prices.
- There is no "indicative" quote: the Brain either prices fully or asks questions.

### 2.5 Nothing books anything
Accepting a site-visit or booking proposal creates a task "Arrange a site visit". There is no
availability check, no slot finder, no agent-callable event creation, and the "booking" draft kind
is unused. Approve and send are two steps, and sending a proposal does not mark the quote sent.

### 2.6 No accounting, no growth loop
No invoices table, no Xero. Jobs have a manual "Mark invoiced". Hermes classifies invoices and
remittances but they become tasks on nothing. Nothing asks for reviews, tracks monitoring or
maintenance renewals, re-engages dormant customers, or proposes upsells.

### 2.7 The UI mirrors the subsystems
Eleven main nav items plus eight settings items. The lead page has ten panels. The Inspector page
explains itself in paragraphs, shows every guardrail decision including noise (rejected facts),
and repeats the full Hermes view in "Recently read". A legacy "Email AI" settings page and an "AI
N%" on leads refer to the old classifier. There is no Hermes status page.

## 3. The target architecture

```
sources            Titan mail (in and out) · Plaud recordings · website forms · calendar · (later) Xero
                                  │
                   ONE intelligence: Hermes (inspector profile; research profile for the web)
                   reads, decides, investigates, does internal work, prepares customer-facing work
                                  │
                   guardrails: authority · evidence · identity · commercial truth · destructive
                   (src/lib/hermes/authority.ts: one table; nothing else re-decides)
                                  │
         ┌────────────────────────┼─────────────────────────────┐
   Business Brain          the CRM record                 Decisions queue
   designs & prices        (leads, customers, quotes,     ONE place Chris approves,
   any service from        jobs, events, invoices,        changes or rejects what Hermes
   approved data           facts, commitments, audit)     did or wants to do
                                  │
                   proactive loop: Hermes reviews the whole business on a schedule and proposes
```

### 3.1 One intelligence
- Hermes is the only decision-maker. The old classifier is reduced to two mechanical steps that
  are not decisions: parsing website forms into structured fields, and the automated-mail
  prefilter (bounces, notifications). Everything else goes straight to Hermes.
- Leads are created from Hermes's own reading (name, service, site, summary, next step), not
  from the old extraction.
- The deterministic `extract/analyse/plan` modules are retired. The one thing they still do that
  matters, finding identity signals (phone, email, quote number, address) for the CRM's identity
  rules, moves into one identity module shared by email, recordings and the Inspector.
- Jev is removed. The "Old rules (comparison only)" line goes.
- When Hermes is unavailable the item waits in the queue and is retried; nothing else reads it.

### 3.2 Autonomy by class, with a dial
Every action Hermes can take has a class and an autonomy level. The levels are:

| Level | Meaning | Default for |
| --- | --- | --- |
| **Do** | Hermes does it; it appears in the feed; Chris can undo | notes, tasks, follow-ups, filing into evidenced work, commitments kept, research, Brain runs, candidate packages |
| **Do and ask** | Hermes does the work and the result waits for one click | quotes (incl. indicative), reply drafts, bookings (pencilled, not confirmed), linking a sender |
| **Ask first** | Hermes proposes; nothing happens until Chris says so | anything irreversible, financial approvals, merges |
| **Never** | code refuses it for any agent | sending, confirming dates, pricing promises, discounts, accepting terms |

Chris can move a class up or down the dial in Settings → Hermes (within the "Never" floor). The
confidence threshold applies per class, not globally: Hermes at 70% can still create a task; it
needs 85% to pencil a booking. This replaces the single `HERMES_MIN_CONFIDENCE`.

### 3.3 One Decisions queue
Every item that waits on Chris becomes a **decision card** in one queue, whatever produced it:

```
[ Quote ]  Mark Zuckerberg · 3-camera indicative quote, single storey · Q-1031 · $2,340 inc GST
           Hermes: "He's researching prices; this is the Good tier with the 4-channel kit, labour
           from RES_CCTV_SINGLE_3. Subject to a site check."
           [ Approve & send ]  [ Change ]  [ Reject ]        view quote · view email draft
```

Card types: quote, reply, booking, who-is-this, link sender, fact conflict, package candidate,
knowledge candidate, question from Hermes, and "look at this" (genuine judgement). One badge. One
page. The lead, customer and job pages show only that record's cards. The Inbox "needs review"
tab, the Recordings "to file" tab, the Approvals page, and the two Business Brain queues are
folded into it. A decision made anywhere clears it everywhere.

### 3.4 Hermes asks, Chris answers, Hermes learns
A "Question from Hermes" card: "What's our labour allowance for a 6-camera double storey?",
"Do we still install Paradox panels?", "What's the markup on Ajax?". Chris answers in the card.
The answer is stored as an approved learning (the existing `brain_candidates` workflow kind, now
with an answer field) and goes into every future context pack, or, when it is a commercial value,
into the Business Brain policy or package it belongs to, still through the approval record. Hermes
never asks the same question twice while an answer stands.

### 3.5 Proactive Hermes
A scheduled "business review" (hourly for operations, daily for growth and money), run as a
separate Hermes task with the CRM's read tools and the same write authority, producing decision
cards and a morning brief:
- Operations: quotes sent and not followed up, leads with no contact in N hours, visits with no
  outcome recorded, jobs done but not invoiced, commitments overdue, bookings tomorrow with no
  confirmation. (This replaces the automations rules engine: the rules become Hermes's checklist,
  Hermes writes the task or draft, de-duplicated against what is already open.)
- Money: invoices unpaid past terms (chase draft), remittances to reconcile, supplier bills due.
- Growth: review request after a completed job, maintenance or monitoring renewals due, dormant
  customers, upsell on recent installs (app viewing, extra camera, alarm on a CCTV-only site),
  referral prompts. Every customer-facing piece is a draft card; Hermes never sends.
- The brief: "Today: 2 quotes to approve, a 4pm booking to confirm, J-1012 ready to invoice,
  3 customers due a review request."

### 3.6 Quoting any service, including indicative quotes
- A **quote composer** replaces the two dead ends (CCTV-only Brain output, free-text manual
  quotes): it takes product lines (catalogue product, quantity), a labour package and materials,
  and costs them from approved trade prices and the markup policy. Any service. The CCTV Brain
  becomes one *designer* that produces composer input; an **alarm designer** (Ajax first: hub,
  detectors by room count, keypad, siren, app monitoring) is the second; access control and
  intercom later.
- **Indicative quotes**: a quote kind with a price band and "subject to site check" wording,
  produced from an approved kit per storey/size when the enquiry is clearly research ("just
  looking", "ballpark"). The Brain's confidence and the sales read already detect this. Still
  approved by Chris; one click to send.
- The proposal PDF gets kinds (cctv, alarm, access, intercom) and product cards for any category.
  Manual quotes built in the composer get approval and the PDF too.
- Catalogue: alarm categories (panel/hub, detector, keypad, siren, comms module, monitoring
  plan) with spec schemas; Ajax alarm products with quote content and images; alarm kits and
  installation packages (values entered by Chris, as for CCTV).

### 3.7 Suppliers: the research profile can shop
- The connector interface is generalised (login, product page parse, catalogue search, SKU
  match) and **Clear Digital** is the second connector, for Ajax. Credentials are entered once by
  Chris in the CRM and stored encrypted as today.
- Hermes's research profile may trigger a price refresh for products it needs for a quote. The
  price-approval policy stays: a new product's first trade price and any change above the review
  threshold wait for Chris; a refresh within the threshold is recorded and used. A supplier
  product Hermes finds that is not in the catalogue becomes a product candidate (with the parsed
  specs and image) for one-click approval, so the catalogue grows as quotes need it.
- Retail or RRP is never a cost. A quote with any unapproved cost is "not fully priced" and says
  exactly which line.

### 3.8 Bookings
- An **availability engine**: business hours, existing events and jobs (CRM and iCloud), travel
  buffer, technician assignment.
- Hermes proposes a slot ("Wed 8 Oct, 4:00–5:00 pm, Unit A, 110 Mt Eden Rd, with Chris") as a
  booking card. "Confirm & send" creates the event (synced to the calendar) and sends the
  confirmation email in one click. "Change" opens the slot picker. Nothing is held in the
  calendar until Chris confirms, so the customer never sees a time Chris did not approve.
- Site visit outcomes feed the next step: a held visit with notes or photos lets Hermes prepare
  the firm quote.

### 3.9 One-click customer-facing actions
Approve-and-send on quotes and replies; sending a proposal marks the quote sent and starts the
follow-up clock; a reply goes in the thread. Approve-and-confirm on bookings. Everything else is
already internal.

### 3.10 Accounting
- An `invoices` table (number, customer, job, lines, total, issued, due, paid, Xero id) and
  `supplier_bills`. Job done → invoice drafted by Hermes from the accepted quote → Chris approves
  → issued (to Xero when connected, otherwise PDF + email). Remittances and payment emails are
  matched to invoices; overdue invoices get a chase draft; supplier invoices and statements go to
  a payables list with due dates.
- Xero integration is the second step (OAuth app, invoices and payments sync). Until then the CRM
  is the ledger of record for job invoices only.
- A **Money** page: receivable, overdue, payables due, last 30 days, with the decision cards for
  each.

### 3.11 Recordings
Plaud sync joins the worker loop. One identity module. A recording's transcript turns are what
Hermes cites. A call where Chris says "I'll quote you an Ajax alarm" produces the alarm designer's
input, the research profile fills in prices from Clear Digital, and a quote card appears.

## 4. The new interface

Organised by what Chris does, not by subsystem. Seven items, one badge.

| Nav | What is there |
| --- | --- |
| **Home** | The morning brief; the Decisions queue (cards); today's schedule; what Hermes did since you last looked (the feed, compact, one line each, expandable). Replaces Today, Inspector, Approvals, Inbox-needs-review, Recordings-to-file. |
| **Pipeline** | Leads → quoted → booked → jobs, as one kanban or table with the next step on each card. Replaces Leads, Quotes list and Jobs list as separate screens (each remains reachable as a filter). |
| **Customers** | Customers and sites, with history. |
| **Schedule** | Calendar, dispatch, My day (My day stays the field view for technicians). |
| **Money** | Quotes sent, invoices, payments, payables; decision cards for each. |
| **Knowledge** | The Business Brain: catalogue, suppliers and prices, kits and packages, policies, proposed packages, research and learnings, Hermes's questions and answers. |
| **Sources** | Inbox (all mail, read-only unless Chris wants to reply by hand), Recordings, with "Read again". Secondary, not a daily stop. |
| Settings | Hermes (autonomy dial, status, connection), email accounts, calendar, proposals, staff, system status. "Email AI" is removed. |

Record pages: a lead/customer/job page has three tabs: **Overview** (facts, next step, the
decision cards for this record, journey bar), **Conversation** (timeline: emails, calls, notes,
Hermes's reasoning collapsed), **Work** (quotes, visits, jobs, invoices). The ten panels become
three tabs.

Decision card content: what Hermes did or wants to do (one sentence), why (one or two sentences),
the thing itself (quote, draft, slot), the buttons. Guardrail detail, rejected facts and audit
rows are behind "details", not on the card.

## 5. What gets removed or restructured

| Remove | Why |
| --- | --- |
| Anthropic/rules email classifier as a decision-maker (`src/lib/ai/*`, pipeline steps E, `AI_PROVIDER`, `AI_LEAD_CONFIDENCE_THRESHOLD`), the Email AI settings page, lead "AI N%" | Hermes decides; two brains conflict |
| `extract.ts`, `analyse.ts`, `plan.ts`, `jev.ts`, `jev_observations`, `JEV_SHADOW` | Comparison and fallback only; keeps 700 lines of a second interpretation alive |
| The Inbox "needs review" queue, Recordings "to file", Approvals page, Business Brain Research/Packages queues as separate surfaces | One Decisions queue |
| The automations rules engine as a task writer | Hermes's proactive loop does it with judgement and de-duplication |
| `leads.nextAction` as a typed field, `followUpAt` as a separate clock | The next step is Hermes's and lives on the card |
| Duplicate phone/name helpers, four identity matchers | One identity module |
| `propose_bom` capability, `queueStatus()`, the unreachable outbound-inspection branch | Dead |

| Restructure | Into |
| --- | --- |
| `createLeadFromEmail` from classifier extraction | from Hermes's reading |
| Router + MCP double write paths for tasks and drafts | one `work` module both call, with one de-duplication |
| `kickInspectorQueue` + loop + synchronous `inspect()` calls | one queue, everything goes through it |
| `HERMES_MIN_CONFIDENCE` | per-class autonomy and thresholds in Settings → Hermes |
| CCTV Brain output → quote | CCTV designer → quote composer |

## 6. Phases

Each phase is a development run that leaves the system deployable and tested. Order is by value
and by what unblocks the rest.

**Phase 1: one brain, one queue (foundation).** Fix the four defects visible today (email-body
evidence refs with quote fallback; site/thread candidates for unknown senders so Zavier and Tim's
work is found; open tasks count as evidence for "no action"; no lead facts from accounting mail).
Retire the classifier as decision-maker, Jev and the deterministic planner; one identity module;
leads from Hermes's reading; one work module. Build the Decisions queue and feed, and make Home the
landing page with the brief. Settings → Hermes with the autonomy dial and a status card.
Outcome: the Inspector screenshot problems are gone, and Chris has one place to look.

**Phase 2: quote anything, including indicative.** Quote composer; CCTV designer refactor;
indicative quotes; proposal kinds and cards for any category; alarm catalogue categories and
Ajax products; Clear Digital connector; research profile may refresh prices and propose products;
alarm designer (Ajax). Outcome: "three cameras, just researching" → indicative quote card;
"I'll quote you an Ajax alarm" on a call → alarm quote card with Clear Digital prices and images.

**Phase 3: bookings and one-click sending.** Availability engine; booking cards; confirm-and-send;
approve-and-send on quotes and replies; quote status follows sending; site-visit outcomes feed
the firm quote. Plaud sync in the loop.

**Phase 4: proactive Hermes, money and growth.** The scheduled business review and morning brief
(replacing automations); invoices and payables; remittance matching; chase drafts; review
requests, renewals, dormant and upsell proposals; the Money page. Xero as 4b.

**Phase 5: the interface.** Pipeline, Customers, Schedule, Knowledge and Sources as described;
record pages as three tabs; remove the old pages. Parts of this land earlier where a phase needs
them (Home and Decisions in Phase 1, Money in Phase 4).

Throughout: `hermes:check` invariants extended for each new authority (a booking is never
confirmed by Hermes; an indicative quote always carries its wording; a price from a connector is
never approved by an agent above the threshold), the secret scan, and the restricted Inspector
profile.

## 7. What I need from Chris before Phase 2

1. **Clear Digital**: a trade login exists? It will be entered once in Settings → Knowledge →
   Suppliers (encrypted), never pasted to me.
2. **Which services to quote**, in order: CCTV, Ajax alarm, then access control, intercom? Any
   others (gates, networking)?
3. **Indicative quote rules**: a fixed Good-tier kit per size and storey, a price band
   (e.g. ±10%), and the wording Chris wants ("subject to site check, valid 30 days").
4. **Xero**: in use? If so, Phase 4 includes the connection; if not, invoices stay in the CRM.
5. **Autonomy comfort**: the defaults in 3.2 keep every customer-facing step behind one click.
   Say if any class should start higher or lower.
6. **Reviews and recurring revenue**: the Google review link; whether monitoring/maintenance
   plans are sold today and where their renewal dates live.

## 8. Risks

- Model cost and latency rise with the proactive loop and research; the loop runs on a schedule
  with a budget per run, and research is only called when a quote needs it.
- The Decisions queue is the new single point of failure for Chris's attention: every card must
  be short, and Hermes's "Do" level must be tuned so the queue holds decisions, not noise.
- Supplier sites change; connectors need the same test-connection and audit as IT Plus, and a
  failed refresh must leave the last approved price in place, never a blank or a guess.
- Retiring the classifier removes the current fallback when Hermes is down; the queue holds items
  and retries, and the Home brief shows "Hermes offline since …" so it is never silent.
