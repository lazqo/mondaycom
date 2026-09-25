/**
 * Production-readiness pass: setup checklist, global search, customer history, review quick
 * actions, technician permissions, private file access, health endpoint, security headers.
 */
import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const RUN = `pp${Date.now().toString(36)}`;

async function login(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(dashboard|my-day)$/);
}

test.describe("Production polish", () => {
  test.describe.configure({ mode: "serial" });
  const techEmail = `tech-${RUN}@test.local`;
  const techPassword = "technician-pass-123";
  const customerName = `Search Customer ${RUN}`;
  const customerPhone = "021 777 8899";

  test("setup checklist derives its state and can be completed", async ({ page }) => {
    await login(page);
    await page.goto("/setup");
    await expect(page.getByTestId("setup-step-admin")).toContainText("Admin login");
    await expect(page.getByTestId("setup-step-admin").locator("svg").first()).toBeVisible();
    await expect(page.getByTestId("setup-step-titan")).toBeVisible();
    await expect(page.getByTestId("setup-step-done")).toBeVisible();
    const goBtn = page.getByRole("button", { name: "Go to Today" });
    if (await goBtn.count()) {
      await goBtn.click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByTestId("setup-banner")).toHaveCount(0);
    }
  });

  test("Today greets the user and shows every section", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening), / })).toBeVisible();
    await expect(page.getByTestId("section-overdue-reminders")).toBeVisible();
    await expect(page.getByTestId("section-emails-needing-review")).toBeVisible();
  });

  test("global search finds a customer by name, phone digits, email and address", async ({ page }) => {
    await login(page);
    await page.goto("/contacts");
    await page.getByRole("button", { name: "New customer" }).first().click();
    const dlg = page.getByRole("dialog", { name: "New customer" });
    await dlg.getByLabel("Name *").fill(customerName);
    await dlg.getByLabel("Phone").fill(customerPhone);
    await dlg.getByLabel("Email").fill(`search.${RUN}@example.com`);
    await dlg.getByLabel("Address").fill(`42 Findme Crescent ${RUN}, Titirangi`);
    await dlg.getByRole("button", { name: "Create customer" }).click();
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]+$/);
    for (const q of [customerName, "0217778899", "021 777 88", `search.${RUN}`, `Findme Crescent ${RUN}`]) {
      await page.goto(`/search?q=${encodeURIComponent(q)}`);
      await expect(page.getByRole("link", { name: new RegExp(customerName) }), q).toBeVisible();
    }
    // The search box in the sidebar works too.
    await page.goto("/dashboard");
    await page.getByLabel("Search").first().fill(customerName);
    await page.getByLabel("Search").first().press("Enter");
    await expect(page).toHaveURL(/\/search\?q=/);
    await expect(page.getByRole("link", { name: new RegExp(customerName) })).toBeVisible();
  });

  test("customer page has a timeline and takes notes", async ({ page }) => {
    await login(page);
    await page.goto(`/search?q=${encodeURIComponent(customerName)}`);
    await page.getByRole("link", { name: new RegExp(customerName) }).click();
    await page.getByLabel("New note").fill(`Called about pricing, will decide next week ${RUN}`);
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.locator('[data-testid="timeline-item"][data-kind="note"]')).toContainText(`will decide next week ${RUN}`);
    await page.getByRole("link", { name: "New job" }).click();
    await page.getByLabel("Title *").fill(`History job ${RUN}`);
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
    await expect(page.getByTestId("journey-bar")).toContainText("Job J-");
    await page.getByRole("link", { name: customerName }).first().click();
    await expect(page.locator('[data-testid="timeline-item"][data-kind="job"]').filter({ hasText: `History job ${RUN}` }).first()).toBeVisible();
  });

  test("technicians only see their screens", async ({ page }) => {
    await login(page);
    await page.goto("/settings/users");
    await page.getByRole("button", { name: "Add staff member" }).click();
    const dlg = page.getByRole("dialog", { name: "Add staff member" });
    await dlg.getByLabel("Name *").fill(`Tech ${RUN}`);
    await dlg.getByLabel("Email *").fill(techEmail);
    await dlg.getByLabel("Temporary password *").fill(techPassword);
    await dlg.getByLabel("Role").selectOption("field");
    await dlg.getByRole("button", { name: "Add staff member" }).click();
    await expect(page.getByText(techEmail)).toBeVisible();
    await page.context().clearCookies();
    await login(page, techEmail, techPassword);
    await expect(page).toHaveURL(/\/my-day$/);
    const nav = page.locator("aside nav");
    await expect(nav.getByRole("link", { name: "My day" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Inbox" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Leads" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Staff" })).toHaveCount(0);
    for (const path of ["/inbox", "/leads", "/quotes", "/settings/users", "/settings/mailboxes", "/settings/ai", "/settings/automations", "/dashboard"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/my-day$/);
    }
    await page.goto("/jobs");
    await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  });

  test("attachments, photos and detailed health need a login; headers are set", async ({ request: api }) => {
    const bogus = "00000000-0000-0000-0000-000000000000";
    expect((await api.get(`/api/attachments/${bogus}`)).status()).toBe(401);
    expect((await api.get(`/api/photos/${bogus}`)).status()).toBe(401);
    const health = await api.get("/api/health");
    expect(health.status()).toBe(200);
    const body = await health.json();
    expect(body.ok).toBe(true);
    expect(body.ingestion).toBeUndefined(); // detail is admin/token only
    expect(health.headers()["x-frame-options"]).toBe("DENY");
    expect(health.headers()["x-content-type-options"]).toBe("nosniff");
    const page = await api.get("/login");
    expect(page.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("login is throttled after repeated failures", async ({ page }) => {
    await page.goto("/login");
    // The error from the previous attempt stays on screen, so asserting on the message would pass
    // against a stale one and let the loop outrun the server. Wait for each POST to be answered so
    // all 11 attempts are actually recorded; the limit is 10, so the 11th must be refused.
    for (let i = 0; i < 11; i++) {
      await page.getByLabel("Email").fill(`throttle-${RUN}@test.local`);
      await page.getByLabel("Password").fill("wrong-password");
      const submitted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/login"));
      await page.getByRole("button", { name: "Sign in" }).click();
      await submitted;
    }
    await expect(page.getByText(/Too many attempts/)).toBeVisible();
  });
});
