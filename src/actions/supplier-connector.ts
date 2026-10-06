"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { humanFromUser } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { mapSupplierListing, runSupplierConnector, type SyncResult, type SyncScope } from "@/lib/brain/suppliers/connector";
import { getSupplierPricingSettings, saveSupplierPricingSettings, type SupplierPricingSettings } from "@/lib/brain/supplier-settings";
import { logActivity } from "@/lib/activity";

const uuid = z.string().uuid();

async function run(supplierId: string, scope: SyncScope): Promise<ActionResult<SyncResult>> {
  try {
    const user = await requireAdmin();
    const result = await runSupplierConnector(uuid.parse(supplierId), scope, humanFromUser(user));
    revalidatePath("/settings/brain");
    return ok(result);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Log in with the stored trade login and check a price page is visible. Records nothing. */
export async function testSupplierConnectionAction(supplierId: string): Promise<ActionResult<SyncResult>> {
  return run(supplierId, { kind: "test" });
}

export async function refreshSupplierProductAction(supplierId: string, productId: string): Promise<ActionResult<SyncResult>> {
  return run(supplierId, { kind: "product", productId: uuid.parse(productId) });
}

export async function refreshSupplierSelectedAction(supplierId: string, productIds: string[]): Promise<ActionResult<SyncResult>> {
  const ids = z.array(uuid).min(1, "Select at least one product").max(60).safeParse(productIds);
  if (!ids.success) return fail(ids.error.issues[0]?.message ?? "Select products");
  return run(supplierId, { kind: "selected", productIds: ids.data });
}

export async function refreshSupplierCatalogueAction(supplierId: string): Promise<ActionResult<SyncResult>> {
  return run(supplierId, { kind: "catalogue" });
}

/** Choose which supplier listing a product is (when the automatic match was ambiguous). */
export async function mapSupplierListingAction(supplierId: string, productId: string, sku: string, url: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requireAdmin();
    await mapSupplierListing(uuid.parse(supplierId), uuid.parse(productId), { sku, url }, humanFromUser(user));
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const pricingSchema = z.object({
  autoApprove: z.boolean(),
  jumpPct: z.coerce.number().min(0).max(100),
  retailers: z.array(z.string().max(120)).max(30),
});

/**
 * How connected-supplier prices are approved and which retailers count as valid research sources.
 * Auto-approval only ever applies to a price read logged in, for a product Chris already matched,
 * within the jump threshold; a first-seen product, a bigger jump and any retail price still wait.
 */
export async function saveSupplierPricingSettingsAction(raw: unknown): Promise<ActionResult<SupplierPricingSettings>> {
  try {
    const user = await requireAdmin();
    if (!user.canApprove) return fail("Only Chris can change how supplier prices are approved");
    const parsed = pricingSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the values");
    const before = await getSupplierPricingSettings();
    const next = await saveSupplierPricingSettings(parsed.data);
    await logActivity({ entity: "user", entityId: user.id, actorId: user.id, action: "supplier_pricing_settings_changed", detail: { before, after: next } });
    revalidatePath("/settings/brain");
    return ok(next);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
