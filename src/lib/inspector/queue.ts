/**
 * Emails and conversations waiting for the Inspector. Ingestion never waits for Hermes: it queues
 * the item and carries on. The queue is worked in the background (and every minute by the ingest
 * loop), one item at a time. When Hermes was unavailable the item is still inspected at once (by the
 * fallback, so nothing is lost and Chris sees it), and Hermes is tried again later: after 5, 15 and
 * 60 minutes. A later Hermes reading replaces the fallback only if Chris has not dealt with it yet.
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { inspections, inspectorQueue } from "@/db/schema";
import type { SourceType } from "./types";

const RETRY_MINUTES = [5, 15, 60];

export async function enqueueInspection(sourceType: SourceType, sourceId: string, opts: { force?: boolean } = {}) {
  await db
    .insert(inspectorQueue)
    .values({ sourceType, sourceId, force: !!opts.force })
    .onConflictDoUpdate({ target: [inspectorQueue.sourceType, inspectorQueue.sourceId], set: { force: sql`${inspectorQueue.force} or ${!!opts.force}`, nextAttemptAt: new Date(), updatedAt: new Date() } });
}

/** Take the next item that is due (one worker at a time per item, even across processes). */
async function claim() {
  const rows = await db.execute<{ id: string; source_type: string; source_id: string; force: boolean; attempts: number }>(sql`
    update ${inspectorQueue} set locked_at = now(), updated_at = now()
    where id = (
      select id from ${inspectorQueue}
      where next_attempt_at <= now() and (locked_at is null or locked_at < now() - interval '10 minutes')
      order by created_at
      limit 1
      for update skip locked
    )
    returning id, source_type, source_id, force, attempts`);
  return (rows as unknown as { id: string; source_type: string; source_id: string; force: boolean; attempts: number }[])[0] ?? null;
}

/** Work through what is due. Returns how many items were inspected. */
export async function drainInspectorQueue(opts: { limit?: number; log?: (m: string) => void } = {}): Promise<number> {
  const { inspect } = await import("./inspect");
  let done = 0;
  for (let i = 0; i < (opts.limit ?? 25); i++) {
    const item = await claim();
    if (!item) break;
    const sourceType = item.source_type as SourceType;
    try {
      if (item.attempts > 0) {
        // A retry: if Chris has already dealt with the fallback, leave his decision alone.
        const latest = await db.query.inspections.findFirst({ where: and(eq(inspections.sourceType, sourceType), eq(inspections.sourceId, item.source_id)), orderBy: [desc(inspections.createdAt)], columns: { reviewedAt: true, engine: true } });
        if (latest?.reviewedAt || latest?.engine === "hermes") {
          await db.delete(inspectorQueue).where(eq(inspectorQueue.id, item.id));
          continue;
        }
      }
      const out = await inspect(sourceType, item.source_id, { force: item.force || item.attempts > 0 });
      done++;
      const retry = out?.hermesStatus && !["ok", "not_configured"].includes(out.hermesStatus) && item.attempts < RETRY_MINUTES.length;
      if (retry) {
        await db
          .update(inspectorQueue)
          .set({ attempts: item.attempts + 1, nextAttemptAt: new Date(Date.now() + RETRY_MINUTES[item.attempts] * 60_000), lockedAt: null, lastError: out?.hermesError ?? out?.hermesStatus ?? null, updatedAt: new Date() })
          .where(eq(inspectorQueue.id, item.id));
      } else {
        await db.delete(inspectorQueue).where(eq(inspectorQueue.id, item.id));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.log?.(`[inspector] ${sourceType} ${item.source_id}: ${message}`);
      // Never lose it: try again later, a few times.
      if (item.attempts < RETRY_MINUTES.length) {
        await db.update(inspectorQueue).set({ attempts: item.attempts + 1, nextAttemptAt: new Date(Date.now() + RETRY_MINUTES[item.attempts] * 60_000), lockedAt: null, lastError: message.slice(0, 500), updatedAt: new Date() }).where(eq(inspectorQueue.id, item.id));
      } else {
        await db.update(inspectorQueue).set({ lockedAt: null, lastError: message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 24 * 3600_000), updatedAt: new Date() }).where(eq(inspectorQueue.id, item.id));
      }
    }
  }
  return done;
}

let running: Promise<number> | null = null;

/** Start working the queue in the background, unless it already is. Never throws. */
export function kickInspectorQueue(log: (m: string) => void = console.error): void {
  if (running) return;
  running = drainInspectorQueue({ log })
    .catch((err) => {
      log(`[inspector] queue: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    })
    .finally(() => {
      running = null;
    });
}

/** For tests: wait for the background worker, then work anything still due. */
export async function settleInspectorQueue(): Promise<void> {
  if (running) await running;
  await drainInspectorQueue();
}

/** Items Chris may want to know about: still waiting or retrying. */
export async function queueStatus() {
  const rows = await db.select().from(inspectorQueue).where(isNotNull(inspectorQueue.id));
  return { waiting: rows.length, retrying: rows.filter((r) => r.attempts > 0).length, lastError: rows.find((r) => r.lastError)?.lastError ?? null };
}
