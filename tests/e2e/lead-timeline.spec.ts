/**
 * End-to-end: the Lead Profile timeline, sent-mail sync from the Titan Sent folder, and two-way
 * sync with the Titan calendar.
 *
 *   1. A new inbound email appears on the lead's timeline.
 *   2. An email sent from the CRM appears on the timeline exactly once, even after its copy in the
 *      Sent folder is synced.
 *   3. An email sent outside the CRM (webmail, phone) is picked up from Sent onto the right lead.
 *   4. A site visit booked in the CRM appears in the calendar.
 *   5. An event added or changed in the calendar shows up in the CRM.
 *   6. Converting the lead keeps its whole history, and the customer's timeline shows it too.
 *
 * Needs the local IMAP server (tests/support/dovecot/start.sh) and CalDAV server
 * (tests/support/caldav/start.sh); skipped when either is not running.
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { ImapFlow } from "imapflow";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const IMAP_PORT = Number(process.env.DOVECOT_TEST_PORT ?? 1143);
const IMAP_USER = "crm@test.local";
const IMAP_PASS = "crm-password";
const DAV_PORT = Number(process.env.CALDAV_TEST_PORT ?? 5232);
const DAV_USER = process.env.CALDAV_TEST_USER ?? "crm@test.local";
const DAV_PASS = process.env.CALDAV_TEST_PASS ?? "calendar-password";
const DAV_BASE = `http://127.0.0.1:${DAV_PORT}`;
const RUN = `e2e${Date.now().toString(36)}`;
const CAL = `${DAV_BASE}/${encodeURIComponent(DAV_USER)}/tl-${RUN}/`;
const DAV_AUTH = { Authorization: `Basic ${Buffer.from(`${DAV_USER}:${DAV_PASS}`).toString("base64")}` };

const CUSTOMER_NAME = "Hana Ruatapu";
const CUSTOMER = `hana+${RUN}@example.com`;
const SUBJECT = `CCTV quote for our cafe ${RUN}`;
const ENQUIRY_ID = `<enquiry-${RUN}@example.com>`;

function up(port: number): boolean {
  try {
    execFileSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function mail(o: { from: string; to: string; subject: string; id: string; body: string; inReplyTo?: string; date?: Date }): string {
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.id}`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
    "",
  ].join("\r\n");
}

/** A new email arriving in the inbox. */
function deliver(raw: string, tag: string) {
  const path = `test-results/${RUN}-${tag}.eml`;
  writeFileSync(path, raw);
  execFileSync("tests/support/dovecot/deliver.sh", [path]);
}

/** An email sent from webmail or a phone: the only trace is its copy in the Sent folder. */
async function sentFromPhone(raw: string) {
  const c = new ImapFlow({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  await c.connect();
  try {
    await c.append("Sent", raw, ["\\Seen"]);
  } finally {
    await c.logout();
  }
}

async function dav(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  return fetch(url, { method, body, headers: { ...DAV_AUTH, ...headers } });
}

/** Every event in the test calendar. */
async function calendarObjects(): Promise<{ href: string; etag: string; data: string }[]> {
  const res = await dav(
    "REPORT",
    CAL,
    `<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>`,
    { Depth: "1", "Content-Type": "application/xml" },
  );
  const xml = await res.text();
  return [...xml.matchAll(/<response>([\s\S]*?)<\/response>/g)].flatMap((m) => {
    const href = m[1].match(/<href>([^<]+)<\/href>/)?.[1];
    const etag = m[1].match(/<getetag>([^<]+)<\/getetag>/)?.[1]?.replace(/&quot;/g, '"');
    const data = m[1]
      .match(/<C:calendar-data>([\s\S]*?)<\/C:calendar-data>/)?.[1]
      ?.replace(/&#13;/g, "\r")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    return href && etag && data ? [{ href: `${DAV_BASE}${href}`, etag, data: data.replace(/\r\n[ \t]/g, "") }] : [];
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function syncMail(page: Page) {
  await page.goto("/inbox");
  await page.getByTestId("sync-now").click();
  await expect(page.getByText(/\d+ new, \d+ sent/)).toBeVisible({ timeout: 30_000 });
}

const timeline = (page: Page) => page.getByTestId("timeline");
const items = (page: Page, kind?: string) => timeline(page).locator(kind ? `[data-testid="timeline-item"][data-kind="${kind}"]` : '[data-testid="timeline-item"]');

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test.describe("Lead Profile timeline, Titan Sent folder and Titan calendar", () => {
  test.skip(!up(IMAP_PORT), "local IMAP server not running (tests/support/dovecot/start.sh)");
  test.skip(!up(DAV_PORT), "local CalDAV server not running (tests/support/caldav/start.sh)");
  test.describe.configure({ mode: "serial" });

  let mailboxAddress = "";
  let leadUrl = "";
  let visitEventId = "";

  test("setup: a mailbox that also syncs Sent, and the Titan calendar connected in Settings", async ({ page }) => {
    await login(page);
    await page.goto("/settings/mailboxes");
    // Reuse the test mailbox if an earlier spec connected one; two mailboxes on the same IMAP account
    // would both ingest every message.
    const existing = page.getByTestId("mailbox-card").filter({ hasText: /E2E e2e/ }).first();
    if (await existing.count()) {
      mailboxAddress = (await existing.textContent())!.match(/<([^>]+)>/)![1];
    } else {
      mailboxAddress = `chris+${RUN}@test.local`;
      await page.getByRole("button", { name: "Connect mailbox" }).click();
      const dlg = page.getByRole("dialog", { name: "Connect mailbox" });
      await dlg.getByLabel("Display name *").fill(`E2E ${RUN}`);
      await dlg.getByLabel("Email address *").fill(mailboxAddress);
      await dlg.getByLabel("Username *").fill(IMAP_USER);
      await dlg.getByLabel("Password / app password *").fill(IMAP_PASS);
      await dlg.getByLabel("IMAP host").fill("127.0.0.1");
      await dlg.getByLabel("IMAP port").fill(String(IMAP_PORT));
      await dlg.getByLabel("IMAP port").locator("xpath=../..").getByRole("checkbox").uncheck();
      await dlg.getByLabel("SMTP host").fill("127.0.0.1");
      await dlg.getByLabel("SMTP port").fill("2525");
      await dlg.getByLabel("SMTP port").locator("xpath=../..").getByRole("checkbox").uncheck();
      await expect(dlg.getByLabel(/Also sync sent mail/)).toBeChecked();
      await dlg.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByText(mailboxAddress)).toBeVisible();
    }
    // Catch up with anything already waiting, so the counts below are only this spec's mail.
    await syncMail(page);

    // A fresh calendar for this run, standing in for the Titan calendar.
    expect((await dav("MKCALENDAR", CAL)).status).toBe(201);
    await page.goto("/settings/calendar");
    page.on("dialog", (d) => d.accept());
    if (await page.getByTestId("calendar-connection").count()) {
      await page.getByRole("button", { name: "Disconnect" }).click();
      await expect(page.getByRole("button", { name: "Find calendars" })).toBeVisible();
    }
    await page.getByLabel("Calendar server").fill(`${DAV_BASE}/`);
    await page.getByLabel("Username").fill(DAV_USER);
    await page.getByLabel("Password / app password").fill(DAV_PASS);
    await page.getByRole("button", { name: "Find calendars" }).click();
    await expect(page.getByTestId("calendar-message")).toContainText("Signed in");
    await page.getByLabel("Calendar", { exact: true }).selectOption({ value: CAL.replace("@", "%40") });
    await page.getByRole("button", { name: "Connect calendar" }).click();
    await expect(page.getByTestId("calendar-connection")).toBeVisible();
    await expect(page.getByTestId("calendar-message")).toContainText("Connected. Synced");
  });

  test("1. a new inbound email appears on the lead's timeline", async ({ page }) => {
    deliver(
      mail({
        from: `${CUSTOMER_NAME} <${CUSTOMER}>`,
        to: "info@getsecure.co.nz",
        subject: SUBJECT,
        id: ENQUIRY_ID,
        date: new Date(Date.now() - 60 * 60_000),
        body: [
          "Hi there,",
          "",
          "We run the Kiln Cafe at 88 Ponsonby Road, Ponsonby and would like a quote for CCTV covering the counter, the back door and the outdoor seating. Probably 6 cameras with remote viewing on our phones.",
          "",
          "Could someone come out for a site visit next week?",
          "",
          "Thanks,",
          CUSTOMER_NAME,
          "021 555 0177",
        ].join("\n"),
      }),
      "enquiry",
    );
    await login(page);
    await syncMail(page);
    await page.locator("tr", { hasText: SUBJECT }).getByRole("link", { name: new RegExp(CUSTOMER_NAME) }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);
    leadUrl = page.url();
    await expect(page.getByTestId("lead-profile")).toContainText("021 555 0177");

    // The enquiry opens the timeline, with the original email's headers.
    const enquiry = items(page, "enquiry");
    await expect(enquiry).toHaveCount(1);
    await expect(enquiry.getByTestId("timeline-email")).toContainText(CUSTOMER);
    await expect(enquiry.getByTestId("timeline-email")).toContainText(SUBJECT);

    // The customer writes again: it joins the same lead's timeline.
    deliver(
      mail({
        from: `${CUSTOMER_NAME} <${CUSTOMER}>`,
        to: "info@getsecure.co.nz",
        subject: `Re: ${SUBJECT}`,
        id: `<followup-${RUN}@example.com>`,
        inReplyTo: ENQUIRY_ID,
        date: new Date(Date.now() - 50 * 60_000),
        body: `Forgot to say, we also need a camera on the side lane. ${RUN}`,
      }),
      "followup",
    );
    await syncMail(page);
    await page.goto(leadUrl);
    const inbound = items(page, "email_in");
    await expect(inbound).toHaveCount(1);
    await expect(inbound).toContainText(`camera on the side lane. ${RUN}`);
    await expect(inbound.getByTestId("timeline-email")).toContainText("Received");
  });

  test("2. an email sent from the CRM appears on the timeline once", async ({ page }) => {
    await login(page);
    await page.goto(`/inbox?q=${encodeURIComponent(RUN)}`);
    await page.locator("tr", { hasText: SUBJECT }).first().getByRole("link").first().click();
    await page.getByTestId("reply-open").click();
    await page.getByLabel("Message").fill(`Hi Hana, thanks. Thursday at 10am suits for a site visit. CRM-${RUN}`);
    await page.getByTestId("reply-send").click();
    await expect(page.getByText("Reply sent.")).toBeVisible({ timeout: 20_000 });

    await page.goto(leadUrl);
    const sent = items(page, "email_out").filter({ hasText: `CRM-${RUN}` });
    await expect(sent).toHaveCount(1);
    await expect(sent).toContainText("by Admin");
    await expect(sent.getByTestId("timeline-email")).toContainText("Sent from the CRM");

    // The CRM also filed it in the mailbox's Sent folder. Syncing Sent must not add it again.
    await syncMail(page);
    await page.goto(leadUrl);
    await expect(items(page, "email_out").filter({ hasText: `CRM-${RUN}` })).toHaveCount(1);
  });

  test("3. an email sent from Titan webmail or a phone is synced onto the lead", async ({ page }) => {
    // A reply from the phone, threaded by In-Reply-To…
    await sentFromPhone(
      mail({
        from: `Chris <${mailboxAddress}>`,
        to: `${CUSTOMER_NAME} <${CUSTOMER}>`,
        subject: `Re: ${SUBJECT}`,
        id: `<phone-${RUN}@getsecure.test>`,
        inReplyTo: `<followup-${RUN}@example.com>`,
        body: `Side lane camera noted, I'll add it to the quote. PHONE-${RUN}`,
      }),
    );
    // …and a brand-new message with its own subject, matched by recipient.
    await sentFromPhone(
      mail({
        from: `Chris <${mailboxAddress}>`,
        to: CUSTOMER,
        subject: `Parking at the cafe ${RUN}`,
        id: `<webmail-${RUN}@getsecure.test>`,
        body: `Is there parking out the back for the van? WEBMAIL-${RUN}`,
      }),
    );
    await login(page);
    await syncMail(page);
    await expect(page.getByText(/2 sent/)).toBeVisible();

    await page.goto(leadUrl);
    const phone = items(page, "email_out").filter({ hasText: `PHONE-${RUN}` });
    await expect(phone).toHaveCount(1);
    await expect(phone.getByTestId("timeline-email")).toContainText("Sent from Titan");
    await expect(phone.getByTestId("timeline-email")).toContainText(mailboxAddress);
    await expect(phone.getByTestId("timeline-email")).toContainText(CUSTOMER);
    const webmail = items(page, "email_out").filter({ hasText: `WEBMAIL-${RUN}` });
    await expect(webmail).toHaveCount(1);
    await expect(webmail.getByTestId("timeline-email")).toContainText(`Parking at the cafe ${RUN}`);
  });

  test("4. a site visit booked in the CRM appears in the Titan calendar", async ({ page }) => {
    await login(page);
    await page.goto(leadUrl);
    await page.getByRole("button", { name: "Book site visit" }).click();
    const ev = page.getByRole("dialog", { name: "New event" });
    const inTwoDays = new Date();
    inTwoDays.setDate(inTwoDays.getDate() + 2);
    await ev.getByLabel("Date").fill(ymd(inTwoDays));
    await ev.getByLabel("Start").fill("10:00");
    await ev.getByLabel("End").fill("11:00");
    await ev.getByRole("button", { name: "Create event" }).click();
    await expect(items(page, "site_visit").filter({ hasText: "Upcoming" })).toHaveCount(1);

    // Pushed straight away, without pressing Sync: one event, with a stable UID and a link back.
    const leadId = leadUrl.split("/").pop()!;
    await expect
      .poll(async () => (await calendarObjects()).filter((o) => o.data.includes(`/leads/${leadId}`)).length, { timeout: 20_000 })
      .toBe(1);
    const obj = (await calendarObjects()).find((o) => o.data.includes(`/leads/${leadId}`))!;
    expect(obj.data).toMatch(/UID:crm-[0-9a-f-]{36}@getsecure-crm/);
    expect(obj.data).toContain("CATEGORIES:Site visit");
    visitEventId = obj.data.match(/X-GETSECURE-CRM-EVENT:([0-9a-f-]{36})/)![1];

    // Syncing again does not create a second copy.
    await page.goto("/settings/calendar");
    await page.getByTestId("calendar-sync-now").click();
    await expect(page.getByTestId("calendar-message")).toContainText("Synced");
    expect((await calendarObjects()).filter((o) => o.data.includes(`/leads/${leadId}`))).toHaveLength(1);
  });

  test("5. events added or changed in the Titan calendar show up in the CRM", async ({ page }) => {
    const leadId = leadUrl.split("/").pop()!;
    // Move the site visit to 2pm three days out, the way it would be dragged on a phone.
    const visit = (await calendarObjects()).find((o) => o.data.includes(visitEventId))!;
    const day = new Date();
    day.setDate(day.getDate() + 3);
    const stamp = `${ymd(day).replace(/-/g, "")}`;
    const moved = visit.data
      .replace(/DTSTART:\d{8}T\d{6}Z/, `DTSTART;TZID=Pacific/Auckland:${stamp}T140000`)
      .replace(/DTEND:\d{8}T\d{6}Z/, `DTEND;TZID=Pacific/Auckland:${stamp}T150000`)
      .replace(/LAST-MODIFIED:\d{8}T\d{6}Z/, `LAST-MODIFIED:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`);
    expect((await dav("PUT", visit.href, moved, { "Content-Type": "text/calendar", "If-Match": visit.etag })).ok).toBe(true);

    // And a new appointment made in Titan.
    const uid = `titan-${RUN}`;
    const title = `Supplier meeting ${RUN}`;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Titan//Calendar//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260920T000000Z",
      `DTSTART;TZID=Pacific/Auckland:${stamp}T090000`,
      `DTEND;TZID=Pacific/Auckland:${stamp}T093000`,
      `SUMMARY:${title}`,
      "LOCATION:Penrose",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    expect((await dav("PUT", `${CAL}${uid}.ics`, ics, { "Content-Type": "text/calendar" })).ok).toBe(true);

    await login(page);
    await page.goto("/settings/calendar");
    await page.getByTestId("calendar-sync-now").click();
    await expect(page.getByTestId("calendar-message")).toContainText(/1 new from the calendar, 1 updated/);

    // The lead's timeline shows the visit at its new time, and records that it moved in Titan.
    await page.goto(leadUrl);
    const visitItem = items(page, "site_visit").filter({ hasText: "Upcoming" });
    await expect(visitItem).toContainText("2:00");
    await expect(items(page, "site_visit").filter({ hasText: "Changed in the Titan calendar" })).toHaveCount(1);

    // The CRM calendar shows both, and the site visit still leads to its lead.
    await page.goto(`/calendar?view=week&date=${ymd(day)}`);
    await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByTestId(`event-${visitEventId}`).getByRole("link")).toHaveAttribute("href", `/leads/${leadId}`);
  });

  test("6. converting the lead keeps its whole history, and the customer's timeline shows it", async ({ page }) => {
    await login(page);
    await page.goto(leadUrl);
    // A note and a logged call, so every kind of entry is present.
    await timeline(page).getByLabel("New note").fill(`Wants cameras live before Christmas. NOTE-${RUN}`);
    await timeline(page).getByRole("button", { name: "Add note" }).click();
    await expect(items(page, "note").filter({ hasText: `NOTE-${RUN}` })).toContainText("by Admin");
    await timeline(page).getByRole("tab", { name: "Log a call" }).click();
    await timeline(page).getByLabel("Who called").selectOption("incoming");
    await timeline(page).getByLabel("Call outcome").fill("Confirmed the Thursday visit");
    await timeline(page).getByLabel("Call details").fill(`Asked about night vision. CALL-${RUN}`);
    await timeline(page).getByRole("button", { name: "Log call" }).click();
    await expect(items(page, "call").filter({ hasText: `CALL-${RUN}` })).toContainText("Phone call from the customer");

    const kept = ["enquiry", "email_in", "email_out", "site_visit", "note", "call"];
    const before = await items(page).evaluateAll((els, keep) => els.filter((e) => keep.includes(e.getAttribute("data-kind") ?? "")).map((e) => e.querySelector("p")?.textContent?.trim() ?? ""), kept);
    expect(before.length).toBeGreaterThanOrEqual(9);

    await page.getByRole("button", { name: "Convert to customer" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Convert" }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);

    // The Lead Profile is still there with everything it had, plus the conversion and the new job.
    await page.goto(leadUrl);
    const after = await items(page).evaluateAll((els, keep) => els.filter((e) => keep.includes(e.getAttribute("data-kind") ?? "")).map((e) => e.querySelector("p")?.textContent?.trim() ?? ""), kept);
    expect(after).toEqual(before);
    await expect(items(page, "status").filter({ hasText: "Converted to customer" })).toHaveCount(1);
    await expect(items(page, "job").filter({ hasText: /Job J-\d+ created/ })).toHaveCount(1);

    // The customer's timeline holds the same history, once each, labelled with the lead it came from.
    await page.getByRole("link", { name: /^Customer:/ }).click();
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]+$/);
    const customer = await items(page).evaluateAll((els, keep) => els.filter((e) => keep.includes(e.getAttribute("data-kind") ?? "")).map((e) => e.querySelector("p")?.textContent?.trim() ?? ""), kept);
    expect(customer).toEqual(before);
    await expect(items(page, "email_out").filter({ hasText: `CRM-${RUN}` })).toHaveCount(1);
    await expect(items(page, "email_out").filter({ hasText: `PHONE-${RUN}` })).toHaveCount(1);
    await expect(items(page, "email_in").first()).toContainText(`Lead: ${CUSTOMER_NAME}`);
    await expect(items(page, "job").filter({ hasText: /Job J-\d+ created/ })).toHaveCount(1);
  });

});
