# Connecting a Titan mailbox

The CRM reads new enquiries from a Titan mailbox over IMAP and replies through Titan SMTP.

## In Titan (once)

1. Sign in to Titan webmail as the mailbox you want to connect (e.g. `info@getsecure.co.nz`).
2. **Settings → Third-party email access** (sometimes under "Mail clients"): turn it **on**.
3. If two-factor authentication is on for the account, create an **app password** and use that
   in the CRM instead of the normal password.

Server settings (defaults are pre-filled in the CRM):

| | Host | Port | Security |
| --- | --- | --- | --- |
| IMAP | `imap.titan.email` | 993 | SSL/TLS |
| SMTP | `smtp.titan.email` | 465 | SSL/TLS (587 with STARTTLS also works: untick SSL and use 587) |

EU-hosted Titan accounts use `imap.titan.email` / `smtp.titan.email` as well; if login fails, check
the "Configure Titan on other apps" page in Titan support for your region's hostnames.

## In the CRM

1. **Settings → Email accounts** (admin only) → **Connect mailbox**.
2. Fill in display name, the email address, username (the full address) and the password /
   app password. Leave hosts and ports as pre-filled.
3. **Test connection** — both IMAP and SMTP should say OK.
4. **Connect**, then **Check for new email**. The first sync pulls the last 14 days; after that only new
   messages are fetched (the CRM stores the IMAP UID cursor per mailbox, so nothing is re-imported).

## How ingestion runs

- With `INGEST_IN_PROCESS=true` (the default in `.env.example` and the Render blueprint) the web
  server keeps an IMAP connection open and reacts to new mail immediately (IMAP IDLE), with a
  poll every `INGEST_POLL_SECONDS` as a backstop.
- For hosts that run more than one web instance, run the ingestion as its own process instead:
  `PROCESS_TYPE=worker` on the same Docker image (or `pnpm worker`), and set `INGEST_IN_PROCESS=false`
  on the web service so two processes never watch the same mailbox.
- **Check for new email** on the Inbox or Email accounts page runs one pass on demand.
- Every stored email keeps its full original MIME (`raw_mime`), headers and attachments.

## What happens to each email

| Situation | Result |
| --- | --- |
| Reply on a thread already linked to a lead/customer/job | Attached to it, marked **Known customer**. No AI call. |
| Sender's address matches a customer with an open lead | Attached to that lead, marked **Known customer**. |
| Bounce, auto-reply, newsletter (`List-Unsubscribe`, bulk precedence) | **Not a lead**, no AI call. |
| AI says lead, confidence ≥ threshold (`AI_LEAD_CONFIDENCE_THRESHOLD`, default 0.75) | **New lead** created on the board with name, company, phone, email, service, site, summary, urgency, next action, source = Email, and the thread attached. |
| AI says lead but confidence below threshold, or unsure either way | **Needs review** in the Inbox. A person accepts (optionally editing the fields), links to an existing record, or marks it not a lead. Nothing is created until then. |
| AI says not a lead, confident | **Not a lead**. Stays searchable in the Inbox. |

Replies written in the CRM are sent exactly as typed through Titan SMTP, with correct
`In-Reply-To` / `References` headers, stored on the same thread, and copied to Titan's Sent folder.
The CRM never sends AI-generated text to a customer.

## AI provider

`AI_PROVIDER=auto` uses Anthropic (Claude, model `AI_MODEL`, default `claude-opus-5`) when
`ANTHROPIC_API_KEY` is set, and the built-in offline rules classifier otherwise. The provider is
behind one interface (`src/lib/ai/types.ts`); add a class and a branch in `src/lib/ai/index.ts` to
use another model or vendor. Every classification is stored with provider, model, confidence, the
extracted fields, token usage and the reviewer's decision, so accuracy can be measured over time.
