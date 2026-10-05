/**
 * The Leads table's Next action column beside Status: a default for each stage, Chris's own words
 * when he types them (kept to the stage they were written for), and the lost reason for Lost leads.
 */
import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const RUN = `na${Date.now().toString(36)}`;
const NAME = `Next Action Lead ${RUN}`;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("Next action beside Status: stage defaults, typed actions and the lost reason", async ({ page }) => {
  await login(page);
  await page.goto("/leads");
  await page.getByRole("button", { name: "New lead" }).click();
  const dlg = page.getByRole("dialog", { name: "New lead" });
  await dlg.getByLabel("Lead name *").fill(NAME);
  await dlg.getByRole("button", { name: "Create lead" }).click();

  const row = page.locator("tr", { hasText: NAME });
  const cell = row.getByTestId("next-action");
  // The lead's one next step (src/lib/next-step.ts): contact them, due today.
  await expect(cell).toHaveText(/^Contact Next/);

  // Won: convert it to a job.
  await row.getByLabel("Status").selectOption("won");
  await expect(cell).toHaveText("Convert to a job");

  // Chris writes his own; it stays after a reload.
  await cell.getByRole("button").click();
  await cell.getByLabel("Next action").fill("Ring Tuesday to book the install");
  await cell.getByLabel("Next action").press("Enter");
  await expect(cell).toHaveText("Ring Tuesday to book the install");
  await page.reload();
  await expect(page.locator("tr", { hasText: NAME }).getByTestId("next-action")).toHaveText("Ring Tuesday to book the install");

  // Moved to Quote Sent: the Won note no longer applies, the stage default shows.
  await page.locator("tr", { hasText: NAME }).getByLabel("Status").selectOption("quote_sent");
  await expect(page.locator("tr", { hasText: NAME }).getByTestId("next-action")).toHaveText("Follow up on the quote");

  // Lost: the column is the lost reason.
  await page.locator("tr", { hasText: NAME }).getByLabel("Status").selectOption("lost");
  const lostSection = page.getByRole("region", { name: "Lost leads" });
  await expect(lostSection.locator("th", { hasText: "Lost reason" })).toBeVisible();
  const lostCell = lostSection.locator("tr", { hasText: NAME }).getByTestId("next-action");
  await expect(lostCell).toHaveText("Add the reason");
  await lostCell.getByRole("button").click();
  await lostCell.getByLabel("Lost reason").fill("Went with a cheaper installer");
  await lostCell.getByLabel("Lost reason").press("Enter");
  await page.reload();
  await expect(page.getByRole("region", { name: "Lost leads" }).locator("tr", { hasText: NAME }).getByTestId("next-action")).toHaveText("Went with a cheaper installer");

  // The lead page shows it too.
  await page.getByRole("link", { name: NAME }).click();
  await expect(page.getByTestId("lead-next-action")).toContainText("Lost reason: Went with a cheaper installer");
});
