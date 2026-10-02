/**
 * Supplier trade logins. Stored encrypted (supplier_credentials) and readable only here, only by
 * a supplier price-sync job or an approver. Never by an agent: nothing an agent can call returns
 * them, and this function refuses an agent actor outright.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { supplierCredentials } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { type Actor, GuardrailError } from "@/lib/guard/actor";

export const SUPPLIER_SYNC_PROCESS = "supplier-price-sync";

export async function getSupplierCredential(supplierId: string, actor: Actor): Promise<{ username: string | null; secret: string } | null> {
  const allowed = (actor.kind === "system" && actor.process === SUPPLIER_SYNC_PROCESS) || (actor.kind === "human" && actor.canApprove);
  if (!allowed) throw new GuardrailError("Supplier credentials are only available to the supplier price-sync job.");
  const row = await db.query.supplierCredentials.findFirst({ where: eq(supplierCredentials.supplierId, supplierId) });
  if (!row) return null;
  return { username: row.username, secret: decryptSecret(row.secretEncrypted) };
}

/** Whether a login is stored, without revealing it. Safe for any screen. */
export async function hasSupplierCredential(supplierId: string): Promise<boolean> {
  const row = await db.query.supplierCredentials.findFirst({ where: eq(supplierCredentials.supplierId, supplierId), columns: { supplierId: true } });
  return !!row;
}
