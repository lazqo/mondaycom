import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, type Mailbox } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { ingestRawMessage } from "./store";
import { linkOutboundEmail, processEmail, type ProcessOutcome } from "./pipeline";

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

export type SyncSummary = { fetched: number; stored: number; duplicates: number; outcomes: ProcessOutcome[]; lastUid: number; sentStored?: number };

export type FolderKind = "inbox" | "sent";

const SENT_NAMES = /^(sent|sent items|sent messages|sent mail)$/i;

/**
 * The mailbox's Sent folder. Found once from the server's \Sent special-use flag (or a folder named
 * Sent), then remembered, so later syncs do not have to list every folder again.
 */
export async function resolveSentFolder(client: ImapFlow, mailbox: Mailbox): Promise<string | null> {
  if (mailbox.sentFolder) return mailbox.sentFolder;
  const boxes = await client.list();
  const sent = boxes.find((b) => b.specialUse === "\\Sent") ?? boxes.find((b) => SENT_NAMES.test(b.name));
  if (!sent) return null;
  await db.update(mailboxes).set({ sentFolder: sent.path, updatedAt: new Date() }).where(eq(mailboxes.id, mailbox.id));
  mailbox.sentFolder = sent.path;
  return sent.path;
}

function cursorOf(mailbox: Mailbox, kind: FolderKind) {
  return kind === "inbox"
    ? { uidValidity: mailbox.uidValidity, lastUid: mailbox.lastUid }
    : { uidValidity: mailbox.sentUidValidity, lastUid: mailbox.sentLastUid };
}

function cursorPatch(kind: FolderKind, c: { uidValidity: string; lastUid?: number }) {
  const now = new Date();
  return kind === "inbox"
    ? { uidValidity: c.uidValidity, ...(c.lastUid !== undefined ? { lastUid: c.lastUid } : {}), lastSyncAt: now, lastError: null, updatedAt: now }
    : { sentUidValidity: c.uidValidity, ...(c.lastUid !== undefined ? { sentLastUid: c.lastUid } : {}), sentLastSyncAt: now, lastError: null, updatedAt: now };
}

/**
 * One incremental pass over one folder on an open IMAP connection: fetch UIDs above that folder's
 * stored cursor, store each message, advance the cursor, then file anything new. Inbox messages
 * are classified; Sent messages are attached to the conversation and records they belong to.
 */
export async function syncFolderWithClient(client: ImapFlow, mailbox: Mailbox, kind: FolderKind): Promise<SyncSummary> {
  const folder = kind === "inbox" ? mailbox.folder : await resolveSentFolder(client, mailbox);
  const cursor = cursorOf(mailbox, kind);
  const summary: SyncSummary = { fetched: 0, stored: 0, duplicates: 0, outcomes: [], lastUid: cursor.lastUid };
  if (!folder) return summary;

  const lock = await client.getMailboxLock(folder);
  try {
    const status = client.mailbox;
    if (!status || typeof status === "boolean") throw new Error("Mailbox not open");
    const uidValidity = String(status.uidValidity ?? "");
    let lastUid = cursor.lastUid;
    if (cursor.uidValidity && cursor.uidValidity !== uidValidity) {
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

    summary.lastUid = lastUid;
    const newEmailIds: string[] = [];
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      const chunk = uids.slice(i, i + FETCH_CHUNK);
      for await (const msg of client.fetch(chunk, { uid: true, source: true }, { uid: true })) {
        summary.fetched++;
        if (!msg.source) continue;
        const res = await ingestRawMessage({
          mailboxId: mailbox.id,
          raw: msg.source,
          imapUid: msg.uid,
          mailboxAddress: mailbox.emailAddress,
          direction: kind === "inbox" ? "inbound" : "outbound",
          origin: kind === "inbox" ? "inbox" : "sent_folder",
        });
        if (res.created) {
          summary.stored++;
          newEmailIds.push(res.emailId);
        } else summary.duplicates++;
        if (msg.uid > summary.lastUid) summary.lastUid = msg.uid;
      }
      // Advance the cursor after each chunk so a crash mid-sync never re-downloads everything.
      await db.update(mailboxes).set(cursorPatch(kind, { uidValidity, lastUid: summary.lastUid })).where(eq(mailboxes.id, mailbox.id));
    }
    if (uids.length === 0) {
      await db.update(mailboxes).set(cursorPatch(kind, { uidValidity })).where(eq(mailboxes.id, mailbox.id));
    }
    if (kind === "inbox") {
      for (const id of newEmailIds) summary.outcomes.push(await processEmail(id));
    } else {
      for (const id of newEmailIds) await linkOutboundEmail(id);
    }
    return summary;
  } finally {
    lock.release();
  }
}

/** One pass over the inbox (kept for callers that only want incoming mail). */
export async function syncWithClient(client: ImapFlow, mailbox: Mailbox): Promise<SyncSummary> {
  return syncFolderWithClient(client, mailbox, "inbox");
}

/**
 * Open a connection, sync the inbox and then the Sent folder, close. Used by "Sync now" and the
 * polling fallback. One connection serves both folders.
 */
export async function syncMailboxOnce(mailboxId: string): Promise<SyncSummary> {
  const mailbox = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, mailboxId) });
  if (!mailbox) throw new Error("Mailbox not found");
  const client = createImapClient(connectionFromMailbox(mailbox));
  try {
    await client.connect();
    const inbox = await syncFolderWithClient(client, mailbox, "inbox");
    if (mailbox.syncSent) {
      const fresh = (await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, mailboxId) })) ?? mailbox;
      const sent = await syncFolderWithClient(client, fresh, "sent");
      inbox.sentStored = sent.stored;
    }
    return inbox;
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
export async function watchMailbox(
  mailboxId: string,
  opts: { pollSeconds: number; signal: AbortSignal; log?: (msg: string) => void; folder?: FolderKind },
): Promise<void> {
  const log = opts.log ?? (() => {});
  const kind = opts.folder ?? "inbox";
  let backoff = 5_000;
  while (!opts.signal.aborted) {
    const mailbox = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, mailboxId) });
    if (!mailbox || !mailbox.active) return;
    if (kind === "sent" && !mailbox.syncSent) return;
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
        const s = await syncFolderWithClient(client, fresh, kind);
        if (s.stored > 0) log(`[${mailbox.emailAddress} ${kind}] ${reason}: stored ${s.stored}${kind === "inbox" ? `, ${s.outcomes.map((o) => o.classification).join(",")}` : ""}`);
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
      const folder = kind === "inbox" ? mailbox.folder : await resolveSentFolder(client, mailbox);
      if (!folder) {
        log(`[${mailbox.emailAddress}] no Sent folder found; sent mail will not be synced`);
        await client.logout().catch(() => client.close());
        return;
      }
      // IDLE watches the selected folder, so each folder gets its own connection.
      await client.mailboxOpen(folder);
      backoff = 5_000;
      log(`[${mailbox.emailAddress}] connected, watching ${folder}`);
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
