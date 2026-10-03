/**
 * End-to-end: the CCTV Business Brain on a lead, through to Chris's approval.
 *
 *   0. Chris sets up an approved kit (cameras + recorder + default HDD) in Settings → Kits.
 *   1. A CCTV assessment runs from the lead and shows the decision packet (recorder, the kit's
 *      HDD, no retention promise).
 *   2. Preparing a reply and a quote puts both in the approval queue, and does not mark the lead
 *      as Contacted.
 *   3. A prepared email cannot be sent until it is approved.
 *   4. A prepared quote cannot be marked as sent until it is approved; editing it after approval
 *      takes the approval away.
 *
 * The catalogue rows are invented test values (not real products or prices) inserted for this run
 * and removed afterwards.
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

const EMAIL = process.env.E2E_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@getsecure.co.nz";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "change-me";
const RUN = `bb${Date.now().toString(36)}`;
const MAKER = `E2E Fixture ${RUN}`;
const LEAD = `Mere Tawhiri ${RUN}`;

const sql = postgres(process.env.DATABASE_URL ?? "postgres://localhost/getsecure", { max: 1, onnotice: () => {} });
let leadId = "";
type PackageValues = { estimated_hours: string | null; labour_rate: string | null; material_cost_ex_gst: string | null; complexity_allowance_ex_gst: string | null; allowance_ex_gst: string | null; status: string };
let pkgBefore: PackageValues | undefined;
const KIT = `E2E kit ${RUN}`;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe("CCTV Business Brain", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const [it] = await sql`select id from suppliers where name = 'IT Plus'`;
    const ids: Record<string, string> = {};
    const add = async (category: string, model: string, specs: Record<string, unknown>, cost: number) => {
      const [p] = await sql`
        insert into products (manufacturer, model, category, market, tier, specs, status, source)
        values (${MAKER}, ${model}, ${category}, 'both', ${category === "camera" || category === "nvr" ? "good" : null}, ${sql.json(specs as never)}, 'getsecure_approved', 'e2e fixture')
        returning id`;
      await sql`
        insert into supplier_products (product_id, supplier_id, cost_ex_gst, price_approved, last_checked_at, price_confidence)
        values (${p.id}, ${it.id}, ${cost}, true, now(), 1)`;
      ids[model] = p.id;
    };
    await add("camera", "FX-CAM-4", { resolutionMp: 4, horizontalPixels: 2560, hfovDeg: 100, irRangeM: 30, colourNight: false, wdrDb: 120, codecs: ["H.265"], maxBitrateMbps: 8, poeWatts: 5, analytics: ["human_vehicle"], onvifProfiles: ["S", "T"] }, 100);
    await add("nvr", "FX-NVR-4", { channels: 4, incomingMbps: 40, poePorts: 4, poePerPortW: 25, poeBudgetW: 50, hddBays: 1, maxHddTb: 10, maxTotalTb: 10, features: ["human_vehicle"], onvifProfiles: ["S", "T"] }, 200);
    await add("hdd", "FX-HDD-4TB", { capacityTb: 4, surveillanceRated: true }, 120);
    // The exact 4-camera package with every value entered (TEST VALUES); put back afterwards.
    [pkgBefore] = await sql<PackageValues[]>`select estimated_hours, labour_rate, material_cost_ex_gst, complexity_allowance_ex_gst, allowance_ex_gst, status from installation_packages where key = 'RES_CCTV_SINGLE_4'`;
    await sql`update installation_packages set estimated_hours = 6, labour_rate = 95, material_cost_ex_gst = 80, complexity_allowance_ex_gst = 0, allowance_ex_gst = 790, status = 'getsecure_approved' where key = 'RES_CCTV_SINGLE_4'`;
    const [lead] = await sql`
      insert into leads (name, email, phone, site, service, status, source, notes)
      values (${LEAD}, ${`mere+${RUN}@example.com`}, '021 555 0199', '8 Kowhai Road, Mt Albert, Auckland', 'CCTV', 'new', 'website',
              'Looking for 4 cameras around the house, front door, driveway, back yard and side gate. Want to see them on my phone.')
      returning id`;
    leadId = lead.id;
  });

  test.afterAll(async () => {
    if (leadId) await sql`delete from quotes where lead_id = ${leadId}`;
    if (leadId) await sql`delete from leads where id = ${leadId}`;
    await sql`delete from cctv_kits where name = ${KIT}`;
    await sql`delete from products where manufacturer = ${MAKER}`;
    if (pkgBefore)
      await sql`update installation_packages set estimated_hours = ${pkgBefore.estimated_hours}, labour_rate = ${pkgBefore.labour_rate}, material_cost_ex_gst = ${pkgBefore.material_cost_ex_gst},
                complexity_allowance_ex_gst = ${pkgBefore.complexity_allowance_ex_gst}, allowance_ex_gst = ${pkgBefore.allowance_ex_gst}, status = ${pkgBefore.status} where key = 'RES_CCTV_SINGLE_4'`;
    await sql.end();
  });

  test("Chris sets up an approved kit with its default HDD in Settings → Kits", async ({ page }) => {
    await login(page);
    await page.goto("/settings/brain?tab=kits");
    await page.getByTestId("add-kit").click();
    const form = page.getByTestId("kit-form");
    await form.getByLabel("Key").fill(`E2E_${RUN.toUpperCase()}`);
    await form.getByLabel("Name").fill(KIT);
    await form.getByLabel("Status").selectOption("getsecure_approved");
    await form.getByLabel("Market").selectOption("residential");
    await form.getByLabel("Tier").selectOption("good");
    await form.getByLabel("Exact camera count").fill("4");
    await form.getByLabel("Camera", { exact: true }).selectOption({ label: `${MAKER} FX-CAM-4` });
    await form.getByLabel("Recorder").selectOption({ label: `${MAKER} FX-NVR-4` });
    await form.getByLabel("Default HDD").selectOption({ label: `${MAKER} FX-HDD-4TB` });
    await form.getByTestId("save-kit").click();
    const row = page.getByTestId("kit-row").filter({ hasText: KIT });
    await expect(row).toBeVisible();
    await expect(row).toContainText("FX-HDD-4TB");
    await expect(row).toContainText("Get Secure approved");
  });

  test("assessment, prepared drafts and the approval gate", async ({ page }) => {
    await login(page);
    await page.goto(`/leads/${leadId}`);
    await page.getByTestId("open-assessment").click();
    await expect(page.getByTestId("assessment-form")).toBeVisible();

    // 1. Run the assessment for a 4-camera single-storey house.
    await page.getByLabel("Property", { exact: true }).selectOption("residential");
    await page.getByLabel("Cameras", { exact: true }).fill("4");
    await page.getByLabel("Storeys", { exact: true }).fill("1");
    await page.getByLabel("Areas to cover (one per line)").fill("Front door\nDriveway\nBack yard\nSide gate");
    // No recording profile and no HDD choice: the approved kit brings its 4 TB default HDD.
    await expect(page.getByLabel("Recording profile")).toHaveCount(0);
    await page.getByTestId("run-assessment").click();
    const packet = page.getByTestId("decision-packet");
    await expect(packet).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("packet-nvr")).toContainText("FX-NVR-4");
    await expect(page.getByTestId("packet-hdd")).toContainText("Kit HDD: 4 TB");
    await expect(page.getByTestId("packet-hdd")).toContainText(`Kit HDD (${KIT})`);
    await expect(page.getByTestId("packet-storage")).toContainText("Recording duration depends on camera settings, recording configuration and scene activity");
    await expect(page.getByTestId("packet-storage")).not.toContainText(/approximately \d+ days/);
    await expect(page.getByTestId("packet-labour")).toContainText("RES_CCTV_SINGLE_4");
    await expect(page.getByTestId("packet-total")).toContainText(/inc GST/); // fully priced
    await expect(page.getByTestId("packet-cameras")).toContainText("FX-CAM-4");
    // Supplier cost and margin are internal; the assessment page is internal too, but the
    // prepared email body must not carry them (checked below).

    // 2. Prepare a reply and a quote.
    await page.getByTestId("prepare-email").click();
    await expect(page.getByTestId("prepared")).toContainText("reply draft");
    await page.getByTestId("prepare-quote").click();
    await expect(page.getByTestId("prepared")).toContainText(/quote Q-\d+/);
    await expect(page.getByTestId("prepared")).toContainText("Nothing has been sent");
    const [{ status }] = await sql`select status from leads where id = ${leadId}`;
    expect(status).toBe("new"); // a saved draft never marks the lead as Contacted

    // 3. The draft waits in the approval queue and cannot be sent until approved.
    await page.goto("/approvals");
    const card = page.getByTestId("draft-card").filter({ hasText: LEAD });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("send-draft")).toHaveCount(0);
    const body = await card.getByLabel("Message").inputValue();
    expect(body).not.toMatch(/IT Plus|cost price|margin|markup/i);
    await card.getByTestId("approve-draft").click();
    await expect(card.getByTestId("send-draft")).toBeVisible();

    // Changing an approved draft takes the approval away.
    await card.getByLabel("Message").fill(`${body}\n\nP.S. Happy to work around your schedule.`);
    await card.getByRole("button", { name: "Save changes" }).click();
    await expect(card.getByText("Ready for review")).toBeVisible();
    await expect(card.getByTestId("send-draft")).toHaveCount(0);

    // 4. The quote needs approval before it can be marked as sent.
    const quoteRow = page.getByTestId("approval-quote").filter({ hasText: LEAD });
    await expect(quoteRow).toBeVisible();
    await quoteRow.click();
    await expect(page.getByTestId("quote-approval")).toBeVisible();
    await expect(page.getByTestId("quote-priced")).toHaveText("Fully priced");
    await expect(page.getByTestId("quote-commercial-totals")).toContainText("Gross margin");
    await expect(page.getByTestId("quote-labour")).toContainText("RES_CCTV_SINGLE_4");
    await expect(page.getByRole("button", { name: "Mark as sent" })).toHaveCount(0);
    await page.getByTestId("approve-quote").click();
    await expect(page.getByTestId("quote-approval")).toContainText("Approved by");
    await expect(page.getByRole("button", { name: "Mark as sent" })).toBeVisible();

    // Editing the approved quote voids the approval.
    await page.getByLabel("Line 1 quantity").fill("2");
    await page.getByRole("button", { name: "Save quote" }).click();
    await expect(page.getByText("needs approving again")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("quote-approval")).toContainText("Waiting for Chris");
    await expect(page.getByRole("button", { name: "Mark as sent" })).toHaveCount(0);

    // Approve again, then reprice with current prices: approval is removed, back to Needs Review.
    await page.getByTestId("approve-quote").click();
    await expect(page.getByTestId("quote-approval")).toContainText("Approved by");
    await page.getByTestId("reprice-quote").click();
    await expect(page.getByTestId("quote-approval")).toContainText("Waiting for Chris");
    await expect(page.getByRole("button", { name: "Mark as sent" })).toHaveCount(0);
  });
  test("an upgrade asks about the existing system; unconfirmed cabling gets no upgrade saving", async ({ page }) => {
    await login(page);
    await page.goto(`/leads/${leadId}`);
    await page.getByTestId("open-assessment").click();
    await page.getByLabel("Property", { exact: true }).selectOption("residential");
    await page.getByLabel("Job", { exact: true }).selectOption("upgrade");
    await page.getByLabel("Cameras", { exact: true }).fill("4");
    await page.getByLabel("Storeys", { exact: true }).fill("1");
    const existing = page.getByTestId("existing-system");
    await expect(existing).toBeVisible();
    // Cable type unknown: installation stays unresolved.
    await page.getByTestId("run-assessment").click();
    await expect(page.getByTestId("packet-upgrade")).toContainText("Existing cabling must be confirmed before upgrade labour savings can be applied.");
    await expect(page.getByTestId("packet-readiness")).toContainText("Existing system assessed for the upgrade");
    // Reusable Cat6 in the existing positions: the IP upgrade package.
    await existing.getByLabel("Existing cable type").selectOption("cat6");
    await existing.getByLabel("Existing cable condition").selectOption("reusable");
    await existing.getByLabel("Existing camera locations suitable").selectOption("yes");
    await page.getByTestId("run-assessment").click();
    await expect(page.getByTestId("packet-upgrade")).toContainText("IP upgrade: existing Cat6 runs and camera positions reused");
    await expect(page.getByTestId("packet-labour")).toContainText("RES_CCTV_UPGRADE_IP_4");
  });
});
