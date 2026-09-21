import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, type Mailbox } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { ingestRawMessage } from "./store";
import { processEmail, type ProcessOutcome } from "./pipeline";

const INITIAL_SYNC_DAYS = 14;
const FETCH_CHUNK = 25;

export type MailboxConnection = Pick<
  Mailbox,
  "imapHost" | "imapPort" | "imapSecure" | "smtpHost" | "smtpPort" | "smtpSecure" | "username" | "folder"
> & { password: string };

export function connectionFromMailbox(m: Mailbox): MailboxConnection {
  return { ...m, password: decryptSecret(m.passwordEncrypted) };
}

export function createImapClient(c: MailboxConnection): ImapFlow {
  return new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapSecure,
    auth: { user: c.username, pass: c.password },
    logger: false,
    tls: { rejectUnauthorized: process.env.IMAP_TLS_REJECT_UNAUTHORIZED !== "false" },
  });
}

export type SyncSummary = { fetched: number; stored: number; duplicates: number; outcomes: ProcessOutcome[]; lastUid: number };

/**
 * One incremental pass over an open IMAP connection: fetch UIDs above the stored cursor,
 * store each message, advance the cursor, then classify anything new.
 */
export async function syncWithClient(client: ImapFlow, mailbox: Mailbox): Promise<SyncSummary> {
  const lock = await client.getMailboxLock(mailbox.folder);
  try {
    const status = client.mailbox;
    if (!status || typeof status === "boolean") throw new Error("Mailbox not open");
    const uidValidity = String(status.uidValidity ?? "");
    let lastUid = mailbox.lastUid;
    if (mailbox.uidValidity && mailbox.uidValidity !== uidValidity) {
      // Server renumbered the folder. Start again; Message-ID dedupe prevents duplicate rows.
      lastUid = 0;
    }

    let uids: number[];
    if (lastUid === 0) {
      const since = new Date(Date.now() - INITIAL_SYNC_DAYS * 86400000);
      uids = (await client.search({ since }, { uid: true })) || [];
    } else {
      uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > lastUid);
    }
    uids.sort((a, b) => a - b);

    const summary: SyncSummary = { fetched: 0, stored: 0, duplicates: 0, outcomes: [], lastUid };
    const newEmailIds: string[] = [];
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      const chunk = uids.slice(i, i + FETCH_CHUNK);
      for await (const msg of client.fetch(chunk, { uid: true, source: true }, { uid: true })) {
        summary.fetched++;
        if (!msg.source) continue;
        const res = await ingestRawMessage({ mailboxId: mailbox.id, raw: msg.source, imapUid: msg.uid, mailboxAddress: mailbox.emailAddress });
        if (res.created) {
          summary.stored++;
          newEmailIds.push(res.emailId);
        } else summary.duplicates++;
        if (msg.uid > summary.lastUid) summary.lastUid = msg.uid;
      }
      // Advance the cursor after each chunk so a crash mid-sync never re-downloads everything.
      await db
        .update(mailboxes)
        .set({ lastUid: summary.lastUid, uidValidity, lastSyncAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(mailboxes.id, mailbox.id));
    }
    if (uids.length === 0) {
      await db
        .update(mailboxes)
        .set({ uidValidity, lastSyncAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(mailboxes.id, mailbox.id));
    }
    for (const id of newEmailIds) summary.outcomes.push(await processEmail(id));
    return summary;
  } finally {
    lock.release();
  }
}

/** Open a connection, run one sync pass, close. Used by "Sync now" and the polling fallback. */
export async function syncMailboxOnce(mailboxId: string): Promise<SyncSummary> {
  const mailbox = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, mailboxId) });
  if (!mailbox) throw new Error("Mailbox not found");
  const client = createImapClient(connectionFromMailbox(mailbox));
  try {
    await client.connect();
    return await syncWithClient(client, mailbox);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(mailboxes).set({ lastError: message, updatedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
    throw err;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Verify IMAP credentials by logging in and opening the folder. Throws with a readable message. */
export async function testImapConnection(c: MailboxConnection): Promise<{ folder: string; messages: number }> {
  const client = createImapClient(c);
  try {
    await client.connect();
    const box = await client.mailboxOpen(c.folder, { readOnly: true });
    return { folder: box.path, messages: box.exists };
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Keep a connection open and react to new mail (IMAP IDLE via imapflow's `exists` event), with a
 * periodic poll as a safety net and reconnect with backoff. Resolves only when `signal` aborts.
 */
export async function watchMailbox(mailboxId: string, opts: { pollSeconds: number; signal: AbortSignal; log?: (msg: string) => void }): Promise<void> {
  const log = opts.log ?? (() => {});
  let backoff = 5_000;
  while (!opts.signal.aborted) {
    const mailbox = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, mailboxId) });
    if (!mailbox || !mailbox.active) return;
    const client = createImapClient(connectionFromMailbox(mailbox));
    let syncing = false;
    let queued = false;
    const runSync = async (reason: string) => {
      if (syncing) {
        queued = true;
        return;
      }
      syncing = true;
      try {
        const fresh = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, mailboxId) });
        if (!fresh) return;
        const s = await syncWithClient(client, fresh);
        if (s.stored > 0) log(`[${mailbox.emailAddress}] ${reason}: stored ${s.stored}, ${s.outcomes.map((o) => o.classification).join(",")}`);
      } catch (err) {
        log(`[${mailbox.emailAddress}] sync error: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      } finally {
        syncing = false;
        if (queued) {
          queued = false;
          void runSync("queued");
        }
      }
    };

    try {
      await client.connect();
      await client.mailboxOpen(mailbox.folder);
      backoff = 5_000;
      log(`[${mailbox.emailAddress}] connected, watching ${mailbox.folder}`);
      await runSync("initial");
      const onExists = () => void runSync("new mail").catch(() => {});
      client.on("exists", onExists);
      const timer = setInterval(() => void runSync("poll").catch(() => {}), opts.pollSeconds * 1000);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearInterval(timer);
          client.off("exists", onExists);
          resolve();
        };
        client.once("close", done);
        client.once("error", done);
        opts.signal.addEventListener("abort", done, { once: true });
      });
      await client.logout().catch(() => client.close());
      if (opts.signal.aborted) return;
      log(`[${mailbox.emailAddress}] connection closed, reconnecting`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[${mailbox.emailAddress}] ${message}; retry in ${Math.round(backoff / 1000)}s`);
      await db.update(mailboxes).set({ lastError: message, updatedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
      client.close();
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
  }
}
