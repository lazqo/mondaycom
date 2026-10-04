/**
 * End-to-end: the Hermes-first Lead + Conversation Inspector through the real import paths, with
 * Hermes played by the stand-in API server in tests/support/hermes-mock.ts (the real HTTP path).
 *
 *   1. An email enquiry is read: facts fill the lead, the Business Brain runs, and anything for
 *      the customer waits in Approvals. The lead is still New: prepared is not contacted.
 *   2. A follow-up with a different address is flagged as a conflict, never overwritten.
 *   3. A Plaud call matched by phone files itself; "I'll send the quote tonight" shows on Today as
 *      our commitment and "I'll send the photos tomorrow" as the customer's.
 *   4. A Plaud conversation with only a name waits in "Who is this?" until Chris chooses.
 *
 * Needs the local IMAP server (tests/support/dovecot/start.sh); Plaud is the stand-in CLI named in
 * playwright.config.ts, fed through PLAUD_STATE.
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { PLAUD_STATE } from "./global-setup";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const IMAP_PORT = Number(process.env.DOVECOT_TEST_PORT ?? 1143);
const RUN = `e2e${Date.now().toString(36)}`;
// A surname only this run uses (names are letters only), a phone number and a street number too.
const SURNAME = `Ka${Date.now().toString(36).replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;
const NAME = `Ngaire ${SURNAME[0].toUpperCase()}${SURNAME.slice(1).toLowerCase()}`;
const PHONE = `021 ${String(Date.now()).slice(-7)}`;
const STREET = `${(Date.now() % 800) + 100} Totara Avenue, Mt Eden`;
const NEW_STREET = `${(Date.now() % 9000) + 1000} Rimu Road, Mt Eden`;
const CUSTOMER = `ngaire+${RUN}@example.com`;
const SUBJECT = `Cameras for our house ${RUN}`;
const ENQUIRY_ID = `<insp-${RUN}@example.com>`;

function up(port: number): boolean {
  try {
    execFileSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function deliver(o: { subject: string; id: string; body: string; inReplyTo?: string; from?: string }, tag: string) {
  const raw = [
    `From: ${o.from ?? `${NAME} <${CUSTOMER}>`}`,
    "To: info@getsecure.co.nz",
    `Subject: ${o.subject}`,
    `Message-ID: ${o.id}`,
    `Date: ${new Date().toUTCString()}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
    "",
  ].join("\r\n");
  const path = `test-results/${RUN}-${tag}.eml`;
  writeFileSync(path, raw);
  execFileSync("tests/support/dovecot/deliver.sh", [path]);
}

function plaud(recordings: { id: string; title: string; transcript: string }[]) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE ?? "Pacific/Auckland" }).format(new Date());
  writeFileSync(PLAUD_STATE, JSON.stringify({ recordings: recordings.map((r) => ({ id: r.id, title: r.title, date: today, duration: "2m10s", original: r.transcript, polished: r.transcript })) }));
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

/** The Inspector works in the background: reload until what we expect is there. */
async function eventually(page: Page, url: string, check: () => Promise<void>) {
  await expect(async () => {
    await page.goto(url);
    await check();
  }).toPass({ timeout: 45_000, intervals: [500, 1000, 2000] });
}

async function syncPlaud(page: Page, expected: RegExp) {
  await page.goto("/recordings");
  await page.getByRole("button", { name: "Check for new recordings" }).click();
  await expect(page.getByText(expected)).toBeVisible({ timeout: 30_000 });
}

test.describe("Lead + Conversation Inspector", () => {
  test.skip(!up(IMAP_PORT), "local IMAP server not running (tests/support/dovecot/start.sh)");
  test.describe.configure({ mode: "serial" });

  let leadUrl = "";

  test.afterAll(() => plaud([]));

  test("setup: a mailbox to read from", async ({ page }) => {
    await login(page);
    await page.goto("/settings/mailboxes");
    // Reuse the test mailbox if an earlier spec connected one; two on the same IMAP account would both ingest.
    if (!(await page.getByTestId("mailbox-card").filter({ hasText: /E2E e2e/ }).count())) {
      await page.getByRole("button", { name: "Connect mailbox" }).click();
      const dlg = page.getByRole("dialog", { name: "Connect mailbox" });
      await dlg.getByLabel("Display name *").fill(`E2E ${RUN}`);
      await dlg.getByLabel("Email address *").fill(`chris+${RUN}@test.local`);
      await dlg.getByLabel("Username *").fill("crm@test.local");
      await dlg.getByLabel("Password / app password *").fill("crm-password");
      await dlg.getByLabel("IMAP host").fill("127.0.0.1");
      await dlg.getByLabel("IMAP port").fill(String(IMAP_PORT));
      await dlg.getByLabel("IMAP port").locator("xpath=../..").getByRole("checkbox").uncheck();
      await dlg.getByLabel("SMTP host").fill("127.0.0.1");
      await dlg.getByLabel("SMTP port").fill("2525");
      await dlg.getByLabel("SMTP port").locator("xpath=../..").getByRole("checkbox").uncheck();
      await dlg.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByText(`chris+${RUN}@test.local`)).toBeVisible();
    }
    await syncMail(page);
  });

  test("1. an email enquiry is understood, the Brain runs, and nothing reaches the customer", async ({ page }) => {
    deliver(
      {
        subject: SUBJECT,
        id: ENQUIRY_ID,
        body: `Hi, we'd like a quote for 4 cameras at our house, single storey, at ${STREET}. Would like to view them on my phone. My number is ${PHONE}.\n\nThanks,\n${NAME}`,
      },
      "enquiry",
    );
    await login(page);
    await syncMail(page);

    const row = page.getByTestId("inspector-recent").locator("details").filter({ hasText: SUBJECT });
    // The row appears as soon as Hermes's reading is stored; its actions follow a moment later.
    await eventually(page, "/inspector", async () => expect(row).toContainText("Run the Business Brain", { timeout: 1000 }));
    await expect(row).toContainText("Hermes");
    await expect(row).toContainText("Prepare quote");
    await row.locator("summary").click();
    await expect(row.getByTestId("hermes-recommendation")).toContainText("Recommended next action: Prepare quote");
    await expect(row.getByTestId("hermes-recommendation")).toContainText("Confidence: 92%");
    await expect(row).toContainText("Cameras: 4");
    await row.getByRole("link", { name: NAME }).click();
    await page.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();

    // The lead holds the site and phone (the same street with a suburb is not a conflict); it is
    // still New: prepared is not contacted.
    await expect(page.getByTestId("lead-profile")).toContainText(STREET.split(",")[0]);
    await expect(page.getByTestId("lead-profile")).toContainText(PHONE);
    await expect(page.locator("h1")).toContainText("New");
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
    const tl = page.getByTestId("timeline");
    await expect(tl).toContainText("Hermes read the email");
    await expect(tl).toContainText("Recommended: Prepare quote");
    await expect(tl).toContainText("Business Brain ran");
    await expect(tl).not.toContainText("Email sent to");
  });

  test("2. a different address in a follow-up is flagged, never overwritten", async ({ page }) => {
    deliver({ subject: `Re: ${SUBJECT}`, id: `<insp-2-${RUN}@example.com>`, inReplyTo: ENQUIRY_ID, body: `Sorry, the address is actually ${NEW_STREET}.` }, "address");
    await login(page);
    await syncMail(page);
    const conflict = page.getByTestId("fact-conflict").filter({ hasText: NEW_STREET });
    await eventually(page, "/inspector", async () => expect(conflict).toBeVisible({ timeout: 1000 }));
    await expect(conflict).toContainText(STREET.split(",")[0]);
    await conflict.getByRole("button", { name: "Keep current" }).click();
    await expect(conflict).toHaveCount(0);
    await page.goto(leadUrl);
    await expect(page.getByTestId("lead-profile")).toContainText(STREET.split(",")[0]);
    await expect(page.getByTestId("lead-profile")).not.toContainText(NEW_STREET.split(",")[0]);
  });

  test("3. a Plaud call matched by phone: our commitment on Today, the customer's too", async ({ page }) => {
    plaud([
      {
        id: `of_call${RUN}`,
        title: `Call ${RUN}`,
        transcript: [
          "[00:00 - 00:06] Speaker 1: Hi, it's Chris from Get Secure.",
          `[00:06 - 00:20] Speaker 2: Hi Chris, it's Ngaire on ${PHONE}. Just checking on the cameras for the house.`,
          "[00:20 - 00:31] Speaker 1: No problem, I'll send the quote tonight.",
          "[00:31 - 00:40] Speaker 2: Great, I'll send the photos of the eaves tomorrow.",
        ].join("\n"),
      },
    ]);
    await login(page);
    await syncPlaud(page, /1 new · 1 filed/);

    const ours = page.getByTestId("section-our-commitments").getByTestId("commitment").filter({ hasText: NAME });
    await eventually(page, "/dashboard", async () => expect(ours).toBeVisible({ timeout: 1000 }));
    await expect(ours).toContainText("tonight");
    await expect(ours).toContainText(/send the quote/i);
    const theirs = page.getByTestId("section-waiting-on-customers").getByTestId("commitment").filter({ hasText: NAME });
    await expect(theirs).toContainText(/photos/i);
    await expect(theirs).toContainText("tomorrow");

    await page.goto(leadUrl);
    await expect(page.getByTestId("inspector-panel")).toContainText(/send the quote/i);
    await expect(page.getByTestId("timeline")).toContainText("Chris to send the quote");
    await expect(page.getByTestId("timeline")).toContainText(`${NAME.split(" ")[0]} to send the photos of the eaves`);

    await page.goto("/dashboard");
    await ours.getByRole("button", { name: "Done" }).click();
    await expect(ours).toHaveCount(0);
  });

  test("4. a name alone waits in “Who is this?” until Chris chooses", async ({ page }) => {
    plaud([
      {
        id: `of_name${RUN}`,
        title: `Site chat ${RUN}`,
        transcript: ["Speaker 1: Hi, it's Chris from Get Secure.", `Speaker 2: Hi, ${NAME} here. Could we add a camera for the driveway as well?`].join("\n"),
      },
    ]);
    await login(page);
    await syncPlaud(page, /1 new · 0 filed · 1 to review/);

    const card = page.getByTestId("identity-review").filter({ hasText: `Site chat ${RUN}` });
    await eventually(page, "/inspector", async () => expect(card).toBeVisible({ timeout: 1000 }));
    await expect(card).toContainText("Only name evidence");
    // Hermes may suggest who it is; that alone never files it.
    await expect(card.getByTestId("hermes-identity-suggestion")).toContainText("Hermes suggests");
    const candidate = card.getByTestId("identity-candidate").filter({ hasText: NAME });
    await expect(candidate).toContainText(`name ${NAME}`);
    await candidate.getByRole("button", { name: "It's them" }).click();
    await expect(card).toHaveCount(0);

    await page.goto(leadUrl);
    await expect(page.getByTestId("timeline")).toContainText(`Recorded conversation: Site chat ${RUN}`);
  });

  test("5. a CCTV landing-page lead is a new enquiry: Hermes recommends a quote, never 'no action'", async ({ page }) => {
    const who = `Isapela ${SURNAME[0].toUpperCase()}${SURNAME.slice(1).toLowerCase()}`;
    const form = [
      "New Lead · CCTV Landing",
      "",
      who.toUpperCase(),
      "",
      `Phone 021 088 ${String(Date.now()).slice(-4)} Email isapela+${RUN}@example.com ServiceCCTV Installation`,
      "",
      "REQUEST SUMMARY",
      "",
      `PropertyResidential HomeStoreysDouble storeyCameras2Current SetupNew InstallationTimelineAs Soon As PossibleAddress${(Date.now() % 900) + 10} Solo Place, Manurewa`,
      "",
      `Sent from the Get Secure website. Reply to this email to respond directly to ${who}.`,
    ].join("\n");
    deliver({ subject: "New Lead · CCTV Landing", id: `<landing-${RUN}@updates.getsecure.co.nz>`, body: form, from: "Get Secure Website <noreply@updates.getsecure.co.nz>" }, "landing");
    await login(page);
    await syncMail(page);
    const row = page.getByTestId("inspector-recent").locator("details").filter({ hasText: who });
    await eventually(page, "/inspector", async () => expect(row).toContainText("Run the Business Brain", { timeout: 1000 }));
    await expect(row).toContainText("2 cameras, two-storey");
    await expect(row).not.toContainText("No action");
    await row.locator("summary").click();
    await expect(row.getByTestId("hermes-recommendation")).toContainText("Recommended next action: Prepare quote");
    await expect(row.getByTestId("hermes-recommendation")).toContainText("Confidence: 94%");
    await expect(row).toContainText("Old rules (comparison only)");
  });

  test("6. Hermes unavailable: the email waits for review, never 'no action'", async ({ page }) => {
    deliver({ subject: `Cameras please ${RUN}`, id: `<down-${RUN}@example.com>`, body: "Hi, could I get some cameras for the house? HERMES-DOWN" }, "down");
    await login(page);
    await syncMail(page);
    const card = page.getByTestId("hermes-review").filter({ hasText: `Cameras please ${RUN}` });
    await eventually(page, "/inspector", async () => expect(card).toBeVisible({ timeout: 1000 }));
    await expect(card).toContainText("Hermes could not read it");
    await expect(card).not.toContainText("No action");
    await card.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(card).toHaveCount(0);
  });
  test("7. the rules say 'not a lead' but Hermes reads an enquiry: proposed to Chris, a lead only when accepted", async ({ page }) => {
    // "your order" makes the old rules classifier call this administrative mail; Hermes still reads it.
    const subject = `About your order ${RUN}`;
    const who = `Tama Pro${SURNAME.toLowerCase()}`;
    deliver({ subject, id: `<proposed-${RUN}@example.com>`, body: "Thanks for your order confirmation. While I have you, could I get a quote for 3 cameras for our house? Single storey.", from: `${who} <tama+${RUN}@example.com>` }, "proposed");
    await login(page);
    await syncMail(page);
    const card = page.getByTestId("hermes-review").filter({ hasText: subject });
    await eventually(page, "/inspector", async () => expect(card).toBeVisible({ timeout: 1000 }));
    await expect(card).toContainText("Hermes thinks this is a lead");
    await expect(card).toContainText("The rules classifier said this is not a lead");
    await page.goto("/leads");
    await expect(page.getByText(who)).toHaveCount(0);
    await page.goto("/inspector");
    await card.getByRole("button", { name: "Make it a lead" }).click();
    await expect(card).toHaveCount(0);
    await page.goto("/leads");
    await expect(page.getByText(who).first()).toBeVisible();
  });
});
