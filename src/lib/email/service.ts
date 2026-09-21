import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes } from "@/db/schema";
import { env } from "@/lib/env";
import { syncMailboxOnce, watchMailbox, type SyncSummary } from "./imap";
import { processPendingEmails } from "./pipeline";

/** One pass over every active mailbox, then classify anything still pending. */
export async function runIngestionOnce(log: (m: string) => void = () => {}): Promise<Record<string, SyncSummary | { error: string }>> {
  const boxes = await db.query.mailboxes.findMany({ where: eq(mailboxes.active, true) });
  const out: Record<string, SyncSummary | { error: string }> = {};
  for (const m of boxes) {
    try {
      out[m.emailAddress] = await syncMailboxOnce(m.id);
      log(`[${m.emailAddress}] synced`);
    } catch (err) {
      out[m.emailAddress] = { error: err instanceof Error ? err.message : String(err) };
      log(`[${m.emailAddress}] error: ${out[m.emailAddress]}`);
    }
  }
  await processPendingEmails();
  return out;
}

declare global {
  var __ingestLoop: { controller: AbortController; watched: Set<string> } | undefined;
}

/**
 * Start watching every active mailbox (IMAP IDLE + poll). Picks up mailboxes added later.
 * Idempotent per process. Returns a stop function.
 */
export function startIngestionLoop(log: (m: string) => void = console.log): () => void {
  if (globalThis.__ingestLoop) return () => globalThis.__ingestLoop?.controller.abort();
  const controller = new AbortController();
  const watched = new Set<string>();
  globalThis.__ingestLoop = { controller, watched };

  const refresh = async () => {
    if (controller.signal.aborted) return;
    try {
      const boxes = await db.query.mailboxes.findMany({ where: eq(mailboxes.active, true), columns: { id: true, emailAddress: true } });
      for (const m of boxes) {
        if (watched.has(m.id)) continue;
        watched.add(m.id);
        void watchMailbox(m.id, { pollSeconds: env.INGEST_POLL_SECONDS, signal: controller.signal, log })
          .catch((err) => log(`[${m.emailAddress}] watcher stopped: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => watched.delete(m.id));
      }
      await processPendingEmails();
    } catch (err) {
      log(`ingestion refresh error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 60_000);
  controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  log(`email ingestion loop started (poll every ${env.INGEST_POLL_SECONDS}s)`);
  return () => {
    controller.abort();
    globalThis.__ingestLoop = undefined;
  };
}
