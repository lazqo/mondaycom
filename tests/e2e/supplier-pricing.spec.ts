/**
 * End-to-end: IT Plus authenticated pricing from the CRM, against the IT Plus stand-in started in
 * global-setup (never the real site). Chris stores the trade login, tests the connection, refreshes
 * one product, sees the logged-in trade price waiting for approval and approves it. The login is
 * never shown back. Login and price are TEST VALUES.
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { ITPLUS_MOCK_LOGIN } from "./global-setup";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const sql = postgres(process.env.DATABASE_URL ?? "postgres://localhost/getsecure", { max: 1, onnotice: () => {} });

let supplierId = "";
let productId = "";
let savedCred: Record<string, unknown> | undefined;
let savedConn: Record<string, unknown> | undefined;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe("Supplier pricing: IT Plus trade login", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    [{ id: supplierId }] = await sql`select id from suppliers where name = 'IT Plus'`;
    [savedCred] = await sql`select * from supplier_credentials where supplier_id = ${supplierId}`;
    [savedConn] = await sql`select * from supplier_connectors where supplier_id = ${supplierId}`;
    await sql`update supplier_connectors set status = 'not_tested', last_login_failure_code = null where supplier_id = ${supplierId}`;
  });

  test.afterAll(async () => {
    if (productId) await sql`delete from supplier_products where supplier_id = ${supplierId} and product_id = ${productId}`;
    await sql`delete from supplier_sync_runs where supplier_id = ${supplierId}`;
    if (savedCred) await sql`update supplier_credentials set username = ${savedCred.username as string}, secret_encrypted = ${savedCred.secret_encrypted as string} where supplier_id = ${supplierId}`;
    else await sql`delete from supplier_credentials where supplier_id = ${supplierId}`;
    if (savedConn)
      await sql`update supplier_connectors set status = ${savedConn.status as string}, status_detail = ${savedConn.status_detail as string | null}, last_login_ok_at = ${savedConn.last_login_ok_at as Date | null},
                last_login_failed_at = ${savedConn.last_login_failed_at as Date | null}, last_login_failure = ${savedConn.last_login_failure as string | null}, last_login_failure_code = ${savedConn.last_login_failure_code as string | null},
                last_sync_ok_at = ${savedConn.last_sync_ok_at as Date | null}, last_sync_failed_at = ${savedConn.last_sync_failed_at as Date | null}, last_sync_failure = ${savedConn.last_sync_failure as string | null},
                price_basis_seen = ${savedConn.price_basis_seen as string | null} where supplier_id = ${supplierId}`;
    await sql.end();
  });

  test("store login, test connection, refresh one product, approve its trade price", async ({ page }) => {
    await login(page);

    // Chris stores the IT Plus trade login under Suppliers (encrypted; never shown again).
    await page.goto("/settings/brain?tab=suppliers");
    const form = page.getByTestId("supplier-form").filter({ has: page.locator('input[value="IT Plus"]') });
    await form.getByPlaceholder("Username").fill(ITPLUS_MOCK_LOGIN.username);
    await form.getByPlaceholder("Password / API key").fill(ITPLUS_MOCK_LOGIN.password);
    await form.getByRole("button", { name: "Store login" }).click();
    await expect(form.getByText("Login stored, encrypted.")).toBeVisible();

    // The connector logs in with it.
    await page.goto("/settings/brain?tab=pricing");
    const card = page.getByTestId("supplier-connector");
    await expect(card.getByTestId("connector-status")).toHaveText("Not tested");
    await card.getByTestId("test-connection").click();
    await expect(card.getByTestId("sync-result")).toContainText("Connection OK: logged in to the IT Plus trade account.");
    await expect(card.getByTestId("connector-status")).toHaveText("Connected");
    await expect(card.getByTestId("last-login-ok")).not.toHaveText("never");

    // Refresh one product: the connector finds its IT Plus listing and reads the logged-in trade price.
    [{ id: productId }] = await sql`select id from products where manufacturer = 'TP-Link' and model = 'VIGI InSight S455(2.8mm)'`;
    await sql`delete from supplier_products where supplier_id = ${supplierId} and product_id = ${productId}`;
    await page.reload();
    await card.getByLabel("Product to refresh").selectOption(productId);
    await card.getByTestId("refresh-one").click();
    const item = card.getByTestId("sync-result").getByTestId("sync-item");
    await expect(item).toContainText("New price · awaiting approval");
    await expect(item).toContainText("S455-2.8");
    await expect(item).toContainText("$151.30");
    await expect(item).toContainText("read as ex GST");
    await expect(card.getByTestId("last-sync-ok")).not.toHaveText("never");

    // Chris approves it; only then is it the Business Brain's price.
    const row = card.getByTestId("connector-listing").filter({ hasText: "S455(2.8mm)" });
    await expect(row).toContainText("awaiting approval");
    await row.getByTestId("approve-listing-price").click();
    await expect(row).toContainText("approved");
    const [offer] = await sql`select cost_ex_gst, price_approved, price_source, supplier_sku, stock from supplier_products where supplier_id = ${supplierId} and product_id = ${productId}`;
    expect(offer).toMatchObject({ cost_ex_gst: "151.30", price_approved: true, price_source: "authenticated_web", supplier_sku: "S455-2.8", stock: "In stock" });

    // The login never comes back to the browser.
    const html = await page.content();
    expect(html).not.toContain(ITPLUS_MOCK_LOGIN.password);
    expect(html).not.toContain(ITPLUS_MOCK_LOGIN.username);
  });
});
