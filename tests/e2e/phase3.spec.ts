/**
 * Calendar + dispatch, My Day, follow-up reminders, and the Today dashboard.
 */
import { writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const RUN = `p3${Date.now().toString(36)}`;
// Spread drop times across runs so leftover test data never piles into one slot.
const SLOT_A = 4 + (Date.now() % 8) * 2; // 08:00 … 15:00
const SLOT_B = SLOT_A + 6; // three hours later

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function dragTo(page: Page, sourceSel: string, targetSel: string) {
  const src = page.locator(sourceSel).first();
  const dst = page.locator(targetSel).first();
  await src.scrollIntoViewIfNeeded();
  const a = (await src.boundingBox())!;
  const b = (await dst.boundingBox())!;
  await page.mouse.move(a.x + 8, a.y + 8);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}
/** Synthetic pointer drags can occasionally miss activation; retry until `check` passes. */
async function dragUntil(page: Page, sourceSel: string, targetSel: string, check: () => Promise<void>, attempts = 3) {
  for (let i = 1; ; i++) {
    await dragTo(page, sourceSel, targetSel);
    try {
      await check();
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await page.waitForTimeout(800);
    }
  }
}

// A 1x1 PNG for photo upload.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.describe("Calendar, dispatch, My Day and Today", () => {
  test.describe.configure({ mode: "serial" });
  let jobUrl = "";
  const leadName = `Dispatch Lead ${RUN}`;

  test("Today dashboard shows attention sections and can complete a task", async ({ page }) => {
    await login(page);
    for (const s of ["overdue-tasks", "tasks-due-today", "needs-review", "today-s-jobs-site-visits", "unassigned-jobs", "new-leads", "leads-needing-follow-up", "quotes-waiting-on-action"]) {
      await expect(page.getByTestId(`section-${s}`)).toBeVisible();
    }
    await page.getByRole("button", { name: "Task" }).click();
    await page.getByLabel("Title *").fill(`Ring supplier ${RUN}`);
    await page.getByRole("button", { name: "Add task" }).click();
    const task = page.locator("[data-testid^=task-]", { hasText: `Ring supplier ${RUN}` });
    await expect(task).toBeVisible();
    await task.getByRole("button", { name: /Mark done/ }).click();
    await expect(task).toHaveCount(0);
  });

  test("a lead can have a site visit booked, and converting creates an unscheduled job", async ({ page }) => {
    await login(page);
    await page.goto("/leads");
    await page.getByRole("button", { name: "New lead" }).click();
    const dlg = page.getByRole("dialog", { name: "New lead" });
    await dlg.getByLabel("Lead name *").fill(leadName);
    await dlg.getByLabel("Service").fill("Intercom");
    await dlg.getByLabel("Site address").fill("5 Dispatch Rd, Auckland");
    await dlg.getByRole("button", { name: "Create lead" }).click();
    await page.locator("tr", { hasText: leadName }).getByRole("link", { name: leadName }).click();
    await page.getByRole("button", { name: "Book site visit" }).click();
    const ev = page.getByRole("dialog", { name: "New event" });
    await expect(ev.getByLabel("Title *")).toHaveValue(/Site visit/);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await ev.getByLabel("Date").fill(ymd(tomorrow));
    await ev.getByRole("button", { name: "Create event" }).click();
    await expect(page.getByText(/upcoming/)).toBeVisible();
    await expect(page.getByRole("heading", { name: leadName })).toContainText("Site Visit");
    await page.getByRole("button", { name: "Convert to customer" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Convert" }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
    jobUrl = page.url();
    await expect(page.getByRole("heading", { name: /Unscheduled/ })).toBeVisible();
  });

  test("dispatch: drag the unscheduled job onto the week grid, then move it", async ({ page }) => {
    await login(page);
    const jobId = jobUrl.split("/").pop()!;
    const day = new Date();
    day.setDate(day.getDate() + 1);
    await page.goto(`/calendar?view=week&date=${ymd(day)}`);
    await expect(page.getByTestId(`tray-job-${jobId}`)).toBeVisible();
    await dragUntil(page, `[data-testid="tray-job-${jobId}"]`, `[data-testid="slot-${ymd(day)}-${SLOT_A}"]`, async () => {
      await expect(page.getByTestId(`tray-job-${jobId}`)).toHaveCount(0, { timeout: 8_000 });
    });
    const col = page.getByTestId(`col-${ymd(day)}`);
    const chip = () => col.locator("[data-testid^=event-]", { hasText: `J-` }).filter({ hasText: leadName });
    await expect(chip()).toBeVisible();
    const label = (slot: number) => {
      const h = 6 + Math.floor(slot / 2);
      return new RegExp(`${h > 12 ? h - 12 : h}:00 ${h >= 12 ? "pm" : "am"}`, "i");
    };
    await expect(chip()).toContainText(label(SLOT_A));
    // Move it three hours later on the same day.
    await dragUntil(page, `[data-testid="col-${ymd(day)}"] [data-testid^=event-]:has-text("${leadName}"):has-text("J-")`, `[data-testid="slot-${ymd(day)}-${SLOT_B}"]`, async () => {
      await expect(chip()).toContainText(label(SLOT_B), { timeout: 8_000 });
    });
    // Clicking the chip (on its always-visible left strip) opens the job.
    await page.waitForTimeout(300);
    await chip().click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(jobUrl);
    await expect(page.getByRole("heading", { name: /Scheduled/ })).toBeVisible();
    // Day view has technician lanes; assign to me via the schedule card.
    await page.getByLabel("Technician").selectOption({ label: "Admin" });
    await page.getByRole("button", { name: "Reschedule" }).click();
    await expect(page.getByTestId("scheduled-summary")).toContainText("Scheduled");
    await page.goto(`/calendar?view=day&date=${ymd(day)}`);
    await expect(page.locator("[data-testid^=col-]", { hasText: "Admin" }).locator("[data-testid^=event-]", { hasText: leadName })).toBeVisible();
    // The assignee got a notification.
    await page.getByTestId("notifications-bell").first().click();
    await expect(page.getByText(/scheduled:/).first()).toBeVisible();
  });

  test("My Day: technician walks the job through En route → On site → Done with a note and a photo", async ({ page }) => {
    await login(page);
    const day = new Date();
    day.setDate(day.getDate() + 1);
    await page.goto(`/my-day?date=${ymd(day)}`);
    const card = page.locator("[data-testid^=myday-job-]", { hasText: leadName });
    await expect(card).toBeVisible();
    await expect(card).toContainText("5 Dispatch Rd");
    await card.getByTestId("advance-status").click(); // En route
    await expect(card.getByText("En Route", { exact: true })).toBeVisible();
    await card.getByTestId("advance-status").click(); // On site
    await expect(card.getByText("On Site", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Add note" }).click();
    await card.getByPlaceholder("What happened on site?").fill(`Installed intercom, tested with customer. ${RUN}`);
    await card.getByRole("button", { name: "Save note" }).click();
    await expect(card.getByText(`Installed intercom, tested with customer. ${RUN}`)).toBeVisible();
    const png = `test-results/${RUN}.png`;
    writeFileSync(png, PNG);
    await card.getByLabel("Photo file").setInputFiles(png);
    await expect(card.locator("img")).toHaveCount(1, { timeout: 15_000 });
    await card.getByTestId("advance-status").click(); // Done
    await expect(card.getByText("Done", { exact: true })).toBeVisible();
    // The job page shows the note and photo too.
    await page.goto(jobUrl);
    await expect(page.getByText(`Installed intercom, tested with customer. ${RUN}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Photos \(1\)/ })).toBeVisible();
  });

  test("Automations settings: thresholds save and reminders appear", async ({ page }) => {
    await login(page);
    await page.goto("/settings/automations");
    await page.getByLabel("Job done, not invoiced after (days)").fill("0");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved and re-evaluated.")).toBeVisible();
    await expect(page.locator("[data-testid^=task-]", { hasText: `Invoice job` }).filter({ hasText: leadName })).toBeVisible();
    await page.getByLabel("Job done, not invoiced after (days)").fill("3");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved and re-evaluated.")).toBeVisible();
  });
});
