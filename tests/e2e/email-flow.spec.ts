/**
 * End-to-end: a new email arrives in the (local Dovecot) mailbox → the CRM ingests it →
 * it appears on the Leads board with extracted fields and the original email attached →
 * a Needs-review email is accepted by a person → a reply is sent through SMTP and kept on the thread.
 *
 * Requires tests/support/dovecot/start.sh to be running (skipped otherwise) and uses the offline
 * rules classifier (AI_PROVIDER=rules) so results are deterministic.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { SMTP_OUT_DIR } from "./global-setup";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const IMAP_PORT = process.env.DOVECOT_TEST_PORT ?? "1143";
const RUN = `e2e${Date.now().toString(36)}`;

function dovecotUp(): boolean {
  try {
    execFileSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${IMAP_PORT}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Copy a fixture with a unique sender + Message-ID and drop it into the IMAP inbox. */
function deliver(fixture: string, tag: string, subjectSuffix = ""): { from: string; subject: string } {
  let raw = readFileSync(`tests/fixtures/emails/${fixture}`).toString();
  const from = raw.match(/^From: .*?<?([\w.+-]+@[\w.-]+)>?\s*$/m)![1];
  const unique = from.replace("@", `+${RUN}${tag}@`);
  raw = raw.split(from).join(unique);
  raw = raw.replace(/^Message-ID: .*$/m, `Message-ID: <${RUN}-${tag}@e2e.test>`);
  const subject = raw.match(/^Subject: (.*)$/m)![1] + subjectSuffix;
  raw = raw.replace(/^Subject: .*$/m, `Subject: ${subject}`);
  const path = `test-results/${RUN}-${tag}.eml`;
  writeFileSync(path, raw);
  execFileSync("tests/support/dovecot/deliver.sh", [path]);
  return { from: unique, subject };
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe("Titan-style email ingestion", () => {
  test.skip(!dovecotUp(), "local IMAP server not running (tests/support/dovecot/start.sh)");
  test.describe.configure({ mode: "serial" });

  const mailboxAddress = `sales+${RUN}@test.local`;

  test("connect a mailbox and test the connection", async ({ page }) => {
    await login(page);
    await page.goto("/settings/mailboxes");
    // Remove mailboxes left by earlier runs: they watch the same local IMAP account and would double-ingest.
    page.on("dialog", (d) => d.accept());
    const stale = () => page.getByTestId("mailbox-card").filter({ hasText: /E2E e2e/ });
    for (let n = await stale().count(); n > 0; n--) {
      await stale().first().getByRole("button", { name: "Remove" }).click();
      await expect(stale()).toHaveCount(n - 1, { timeout: 10_000 });
    }
    await page.getByRole("button", { name: "Connect mailbox" }).click();
    const dlg = page.getByRole("dialog", { name: "Connect mailbox" });
    await dlg.getByLabel("Display name *").fill(`E2E ${RUN}`);
    await dlg.getByLabel("Email address *").fill(mailboxAddress);
    await dlg.getByLabel("Username *").fill("crm@test.local");
    await dlg.getByLabel("Password / app password *").fill("crm-password");
    await dlg.getByLabel("IMAP host").fill("127.0.0.1");
    await dlg.getByLabel("IMAP port").fill(IMAP_PORT);
    await dlg.getByLabel("IMAP port").locator("xpath=../..").getByRole("checkbox").uncheck(); // SSL off for local server
    await dlg.getByLabel("SMTP host").fill("127.0.0.1");
    await dlg.getByLabel("SMTP port").fill("2525");
    await dlg.getByLabel("SMTP port").locator("xpath=../..").getByRole("checkbox").uncheck();
    await dlg.getByRole("button", { name: "Test connection" }).click();
    await expect(dlg.getByTestId("test-result")).toContainText("IMAP: OK");
    await expect(dlg.getByTestId("test-result")).toContainText("SMTP: OK");
    await dlg.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(mailboxAddress)).toBeVisible();
  });

  test("a new enquiry lands on the Leads board with extracted fields and the original email", async ({ page }) => {
    const ajax = deliver("02-ajax-alarm.eml", "ajax", ` ${RUN}`);
    const newsletter = deliver("07-newsletter.eml", "news", ` ${RUN}`);
    const vague = deliver("09-vague.eml", "vague", ` ${RUN}`);

    await login(page);
    await page.goto("/inbox");
    await page.getByTestId("sync-now").click();
    await expect(page.getByText(/stored \d+|new,/)).toBeVisible({ timeout: 30_000 });

    // Inbox shows sender, subject, received time, classification, linked lead.
    const ajaxRow = page.locator("tr", { hasText: ajax.subject });
    await expect(ajaxRow).toBeVisible();
    await expect(ajaxRow).toContainText("Dean Walker");
    await expect(ajaxRow.getByText("Lead", { exact: true })).toBeVisible();
    await expect(ajaxRow.getByRole("link", { name: /Dean Walker/ })).toBeVisible();
    const newsRow = page.locator("tr", { hasText: newsletter.subject });
    await expect(newsRow.getByText("Not a lead")).toBeVisible();
    const vagueRow = page.locator("tr", { hasText: vague.subject });
    await expect(vagueRow.getByText("Needs review")).toBeVisible();

    // Not-lead mail is searchable but stays out of Leads.
    await page.goto(`/inbox?filter=not_lead&q=${encodeURIComponent(RUN)}`);
    await expect(page.locator("tr", { hasText: newsletter.subject })).toBeVisible();

    // Leads board: the Ajax lead exists in "New" with extracted columns; the newsletter and vague email do not.
    await page.goto("/leads");
    const newGroup = page.getByRole("region", { name: "New leads" });
    const leadRow = newGroup.locator("tr", { hasText: "Dean Walker" }).filter({ hasText: ajax.from });
    await expect(leadRow).toBeVisible();
    await expect(leadRow.getByRole("button", { name: "Phone" })).toHaveText("027 555 0311");
    await expect(leadRow.getByRole("button", { name: "Service" })).toHaveText("Ajax alarm");
    await expect(leadRow.getByRole("button", { name: "Site" })).toHaveText(/27 Kauri Grove/);
    await expect(leadRow.getByRole("combobox", { name: "Source" })).toHaveValue("email");
    await expect(page.locator("tr", { hasText: "Security Supplies" })).toHaveCount(0);
    await expect(page.locator("tr", { hasText: vague.from })).toHaveCount(0);

    // Lead detail shows the original email and AI summary.
    await leadRow.getByRole("link", { name: "Dean Walker" }).click();
    await expect(page.getByRole("heading", { name: /Dean Walker/ })).toBeVisible();
    await expect(page.getByTestId("lead-original-email")).toContainText("27 Kauri Grove");
    await expect(page.getByTestId("lead-original-email")).toContainText(ajax.from);
    await expect(page.getByText(/Ajax alarm enquiry/).first()).toBeVisible();
  });

  test("a Needs review email can be accepted as a lead by a person", async ({ page }) => {
    await login(page);
    await page.goto(`/inbox?filter=needs_review&q=${encodeURIComponent(RUN)}`);
    await page.locator("tr", { hasText: "question" }).getByRole("link").first().click();
    await expect(page.getByRole("heading", { name: /question/ })).toBeVisible();
    await page.getByRole("button", { name: "Edit & create" }).click();
    await page.getByLabel("Name").fill("J Brown");
    await page.getByLabel("Service").fill("CCTV");
    await page.getByLabel("Site address").fill("West Auckland");
    await page.getByRole("button", { name: "Create lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: /J Brown/ })).toBeVisible();
    await expect(page.getByTestId("lead-original-email")).toContainText("west auckland");
  });

  test("a reply is sent through SMTP and kept on the CRM thread", async ({ page }) => {
    await login(page);
    await page.goto(`/inbox?filter=lead&q=${encodeURIComponent(RUN)}`);
    const row = page.locator("tr", { hasText: "Ajax alarm system for new build" }).first();
    await row.getByRole("link").first().click();
    await page.getByTestId("reply-open").click();
    await expect(page.getByLabel("To")).toHaveValue(/dean\.walker88\+/);
    await expect(page.getByLabel("Subject")).toHaveValue(/^Re: Ajax alarm system/);
    await page.getByLabel("Message").fill(`Hi Dean, thanks for getting in touch. We can do a site visit next Tuesday. ${RUN}`);
    await page.getByTestId("reply-send").click();
    await expect(page.getByText("Reply sent.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Sent from CRM")).toBeVisible();
    await expect(page.getByText(`We can do a site visit next Tuesday. ${RUN}`)).toBeVisible();

    // The SMTP server really received it, threaded to the original.
    const files = readdirSync(SMTP_OUT_DIR).map((f) => readFileSync(`${SMTP_OUT_DIR}/${f}`).toString());
    const sent = files.find((f) => f.includes(RUN));
    expect(sent).toBeTruthy();
    expect(sent).toContain(`In-Reply-To: <${RUN}-ajax@e2e.test>`);
    expect(sent).toContain("Subject: Re: Ajax alarm system for new build");
  });
});
