import { sql } from "drizzle-orm";
import type { Db } from "@/db";

type Tx = Pick<Db, "execute">;

/**
 * Next sequential number for quotes/jobs. Uses a transaction-level advisory lock so two
 * concurrent creates never pick the same number.
 */
export async function nextNumber(tx: Tx, table: "quotes" | "jobs"): Promise<number> {
  const lockKey = table === "quotes" ? 1001 : 1002;
  await tx.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
  const rows = await tx.execute(
    sql`select coalesce(max(number), 1000) + 1 as next from ${sql.identifier(table)}`,
  );
  const first = (rows as unknown as Array<{ next: number | string }>)[0];
  return Number(first?.next ?? 1001);
}
