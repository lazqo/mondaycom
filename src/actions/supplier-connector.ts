"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { humanFromUser } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { mapSupplierListing, runSupplierConnector, type SyncResult, type SyncScope } from "@/lib/brain/suppliers/connector";

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
