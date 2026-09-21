# Staging checkpoint: real Titan mailbox

Goal: prove, on a deployed staging site, that a real Titan email is detected automatically, the
thread is preserved, a reply from the CRM stays threaded, and lead extraction is sensible.
Budget: about 30 minutes. Nothing here needs code changes.

`docs/DEPLOYMENT_HANDOFF.md` is the primary go-live document; this runbook is the longer walkthrough
of the mailbox checks. Production runs the built-in offline classifier (`AI_PROVIDER=rules`), so
there is no AI service to enable — section 4 below is optional and only applies if you ever decide
to turn Claude on.

## 0. What you need in hand

- A hosting account (Railway recommended; Render also pre-configured). See `docs/DEPLOY.md`.
- The Titan mailbox to connect (e.g. `info@getsecure.co.nz`), with **third-party email access** turned
  on in Titan and an **app password** if 2FA is enabled. See `docs/runbooks/titan-mailbox.md`.

## 1. Deploy (Railway)

1. New project → Deploy from GitHub → `lazqo/mondaycom`, branch `claude/pensive-wright-jjs01m`.
2. Add a PostgreSQL service. On the web service set variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `AUTH_SECRET` | `openssl rand -base64 32` output |
   | `APP_URL` | the generated Railway domain (Settings → Networking) |
   | `APP_TIMEZONE` | `Pacific/Auckland` |
   | `INGEST_IN_PROCESS` | `true` |
   | `AI_PROVIDER` | `rules` |
   | `AI_LEAD_CONFIDENCE_THRESHOLD` | `0.75` |
   | `ENCRYPTION_KEY` | `openssl rand -base64 32` output |
   | `HEALTH_TOKEN` | `openssl rand -hex 16` |

3. After the first deploy, open the site: `/setup` creates your admin login and shows the checklist.
4. Open `/api/health` → `{"ok":true,"db":"up"}`. Settings → System status should show the mailbox
   once it is connected.

## 2. Connect the real mailbox

1. **Settings → Email accounts → Connect mailbox.** Fill the address, username (full address), app password.
   Hosts/ports are pre-filled for Titan.
2. **Test connection** → both lines must say OK. If IMAP fails with an auth error, third-party
   access is off or the app password is wrong. If it fails with a TLS error, note the exact text.
3. **Connect**, then **Check for new email**. The first sync imports the last 14 days. Expect the Inbox to
   fill; with `AI_PROVIDER=rules` everything is classified by the offline rules.

## 3. Prove detection, thread and reply

1. From a personal address, send a new email to the mailbox: subject
   `Staging test: CCTV quote for 12 Test St`, a body that mentions two cameras and a phone number.
2. Within ~1 minute (IMAP IDLE) it should appear in **Inbox** without pressing Check for new email.
   If it only appears after pressing it, ingestion is not running: Settings → System status will say
   so, and the service logs will lack `[ingest]` lines.
3. Open it. Check: sender, subject, received time, body, and **Original HTML** if you sent HTML.
   The classification should be **New lead** and a lead named after you should be on the Leads board
   with phone and site filled and the envelope icon linking back.
4. Press **Reply**, write a line, **Send reply**. Check in your personal mailbox: it arrived from the
   Titan address, subject `Re: …`, and threads under your original message.
5. Reply to it from your personal mailbox. It should appear on the same CRM thread as **Known customer**,
   attached to the same lead, with the lead's Last Contact updated. No second lead should appear.
6. Check Titan webmail: the CRM reply is in **Sent**.

Send me: a screenshot of the CRM thread with all three messages, and any log line containing
`error` from the service.

## 4. Optional: turn on the live AI

Skip this unless you have decided you want Claude reading enquiries. Production runs `rules`.

1. Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Redeploy.
2. **Settings → Email AI** shows the active provider and model. Press **Run smoke test**: it classifies the
   bundled realistic enquiries (CCTV, Ajax alarm, access control, intercom, urgent fault, maintenance,
   newsletter, invoice, vague one-liner) and lists the extracted fields and confidence for each.
   Nothing is written to the Inbox or Leads by this test.
3. In **Inbox**, open five real enquiries from the last 14 days and press **Re-run** on each. The AI
   assessment panel shows the new provider, confidence and extracted fields. Re-run does not create
   leads for emails already classified as leads; anything uncertain lands in **Needs review**.

## 5. Decide

Whichever classifier is active, look at **Settings → Email AI → Recent classifications** (provider, confidence, extracted fields, and
whether a person accepted, edited or rejected each one). Automatic lead creation is sensible when:

- confident leads have the right name, phone and service;
- no newsletter or supplier email was created as a lead;
- the uncertain ones are in Needs review, not on the board.

If not, raise `AI_LEAD_CONFIDENCE_THRESHOLD` to `0.9` so more goes to review, and keep three examples
that were wrong.

**Forwarded enquiries are a known limitation** with either classifier: the forward header truncates
the message before extraction, so the lead is created against your own forwarding address with the
phone and site address empty. The full original email is still readable on the thread. See section 9
of `docs/DEPLOYMENT_HANDOFF.md`.
