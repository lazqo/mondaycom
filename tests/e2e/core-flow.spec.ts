import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe("Core workflow: Lead → Customer → Quote → Job → Calendar", () => {
  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/leads");
    await expect(page).toHaveURL(/\/login\?next=%2Fleads/);
  });

  test("rejects a wrong password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password")).toBeVisible();
  });

  test("full flow", async ({ page }) => {
    const stamp = Date.now().toString().slice(-6);
    const leadName = `E2E Lead ${stamp}`;

    await login(page);
    await page.goto("/leads");

    // Leads board shows the requested columns.
    await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
    for (const col of ["Lead", "Company", "Phone", "Email", "Service", "Site", "Status", "Assigned To", "Follow-up", "Last Contact", "Source"]) {
      await expect(page.locator("th", { hasText: col }).first()).toBeVisible();
    }

    // Create a lead.
    await page.getByRole("button", { name: "New lead" }).click();
    const dlg = page.getByRole("dialog", { name: "New lead" });
    await dlg.getByLabel("Lead name *").fill(leadName);
    await dlg.getByLabel("Company").fill("E2E Holdings");
    await dlg.getByLabel("Phone").fill("021 000 1234");
    await dlg.getByLabel("Email").fill(`e2e${stamp}@example.com`);
    await dlg.getByLabel("Service").fill("CCTV install");
    await dlg.getByLabel("Site address").fill("1 Test Rd, Auckland");
    await dlg.getByRole("button", { name: "Create lead" }).click();
    await expect(dlg).toBeHidden();
    const row = page.locator("tr", { hasText: leadName });
    await expect(row).toBeVisible();

    // Inline edit the company cell and check persistence after reload.
    await row.getByRole("button", { name: "Company" }).click();
    const companyInput = row.getByRole("textbox", { name: "Company" });
    await companyInput.fill("E2E Holdings Ltd");
    await companyInput.press("Enter");
    await expect(row.getByRole("button", { name: "Company" })).toHaveText("E2E Holdings Ltd");
    await page.reload();
    await expect(page.locator("tr", { hasText: leadName }).getByRole("button", { name: "Company" })).toHaveText("E2E Holdings Ltd");

    // Move through statuses via the status cell.
    const row2 = page.locator("tr", { hasText: leadName });
    const statusSaved = page.waitForResponse((r) => r.request().method() === "POST" && r.ok());
    await row2.getByRole("combobox", { name: "Status" }).selectOption("contacted");
    await expect(page.getByRole("region", { name: "Contacted leads" }).locator("tr", { hasText: leadName })).toBeVisible();
    await statusSaved;
    await page.reload();
    await expect(page.getByRole("region", { name: "Contacted leads" }).locator("tr", { hasText: leadName })).toBeVisible();

    // Kanban view: drag the card to "Site Visit".
    await page.goto("/leads?view=kanban");
    const card = page.locator("[data-testid^=kanban-card-]", { hasText: leadName });
    await expect(card).toBeVisible();
    const target = page.getByTestId("kanban-column-site_visit");
    for (let attempt = 1; ; attempt++) {
      await card.scrollIntoViewIfNeeded();
      const cardBox = (await card.boundingBox())!;
      const targetBox = (await target.boundingBox())!;
      await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(cardBox.x + cardBox.width / 2 + 20, cardBox.y + cardBox.height / 2 + 5, { steps: 5 });
      // Drop inside the target column at the card's own height (the column spans the full board height).
      await page.mouse.move(targetBox.x + targetBox.width / 2, Math.min(Math.max(cardBox.y + cardBox.height / 2, targetBox.y + 40), targetBox.y + targetBox.height - 10), { steps: 15 });
      await page.waitForTimeout(100);
      const dragSaved = page.waitForResponse((r) => r.request().method() === "POST" && r.ok(), { timeout: 8_000 }).catch(() => null);
      await page.mouse.up();
      if (await dragSaved) break;
      if (attempt >= 3) throw new Error("kanban drag never reached the server");
    }
    await expect(target.locator("[data-testid^=kanban-card-]", { hasText: leadName })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("kanban-column-site_visit").locator("[data-testid^=kanban-card-]", { hasText: leadName })).toBeVisible();

    // Open the lead and convert it to a customer + job.
    await page.getByTestId("kanban-column-site_visit").getByRole("link", { name: leadName }).click();
    await expect(page.getByRole("heading", { name: leadName })).toBeVisible();
    await page.getByRole("button", { name: "Convert to customer" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Convert" }).click();

    // We land on the new job.
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: /J-\d+ · CCTV install — E2E Lead/ })).toBeVisible();
    const jobUrl = page.url();

    // Schedule the job on the calendar.
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const hour = 8 + (Number(stamp) % 9); // 08:00 … 16:00, so runs don't pile into one slot
    await page.getByLabel("Date").fill(iso);
    await page.getByLabel("Start").fill(`${String(hour).padStart(2, "0")}:00`);
    await page.getByLabel("End").fill(`${String(hour + 2).padStart(2, "0")}:00`);
    await page.getByRole("button", { name: "Schedule job" }).click();
    await expect(page.getByTestId("scheduled-summary")).toContainText("Scheduled");
    await expect(page.getByRole("heading", { name: /Scheduled$/ }).first()).toBeVisible();

    // Calendar shows the job event and links back to the job.
    await page.goto(`/calendar?view=week&date=${iso}`);
    const dayCol = page.getByTestId(`col-${iso}`);
    const jobEvent = dayCol.locator("[data-testid^=event-]", { hasText: leadName });
    await expect(jobEvent).toBeVisible();
    await expect(jobEvent.getByRole("link")).toHaveAttribute("href", jobUrl.replace(/^https?:\/\/[^/]+/, ""));
    await jobEvent.click({ position: { x: 8, y: 8 } }); // the left strip is always visible even when chips overlap
    await expect(page).toHaveURL(jobUrl);

    // Create a quote for the customer from the lead page and accept it.
    await page.locator('a[href^="/leads/"]', { hasText: leadName }).click();
    await expect(page.getByRole("heading", { name: leadName })).toBeVisible();
    await page.getByRole("link", { name: "+ New quote" }).click();
    await expect(page.getByRole("heading", { name: "New quote" })).toBeVisible();
    await page.getByLabel("Title *").fill(`Quote ${stamp}`);
    await page.getByLabel("Line 1 description").fill("4x dome cameras installed");
    await page.getByLabel("Line 1 quantity").fill("4");
    await page.getByLabel("Line 1 unit price").fill("250");
    await expect(page.getByTestId("quote-total")).toHaveText("$1,150.00"); // 1000 + 15% GST
    await page.getByRole("button", { name: "Create quote" }).click();
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: /Q-\d+ · Quote/ })).toBeVisible();

    await page.getByRole("button", { name: "Mark as sent" }).click();
    await expect(page.getByRole("heading", { name: /Q-\d+/ }).getByText("Sent")).toBeVisible();

    // The lead follows the quote: Quote Sent.
    await page.goto("/leads");
    await expect(page.getByRole("region", { name: "Quote Sent leads" }).locator("tr", { hasText: leadName })).toBeVisible();

    // Persistence check: everything is in Postgres and survives a fresh session.
    await page.context().clearCookies();
    await login(page);
    await page.goto("/contacts");
    await expect(page.getByRole("link", { name: leadName })).toBeVisible();
    await page.goto("/jobs");
    await expect(page.locator('a[href^="/jobs/"]', { hasText: leadName })).toBeVisible();
  });
});
