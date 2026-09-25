/**
 * Pulls new recordings from Plaud into the CRM. Idempotent: a recording already imported is
 * skipped, so the sync can run as often as you like.
 */
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { listRecent, fetchBestTranscript, fetchTranscript, plaudConfigured } from "./plaud";
import { matchRecording } from "./match";

export type ImportSummary = { checked: number; imported: number; attached: number; review: number; cleaned: number; errors: string[] };

/** How long to keep asking for a cleaned-up transcript Plaud has not produced yet. */
const POLISH_RETRY_DAYS = 14;
/** How often to ask again for one recording within that time. */
const POLISH_RETRY_HOURS = 6;
/** Most recordings to ask about in one run, so a first run over old recordings stays gentle. */
const POLISH_BATCH = 20;

export async function importRecentRecordings(opts: { days?: number; log?: (m: string) => void } = {}): Promise<ImportSummary> {
  const log = opts.log ?? (() => {});
  const summary: ImportSummary = { checked: 0, imported: 0, attached: 0, review: 0, cleaned: 0, errors: [] };
  if (!plaudConfigured()) return summary;

  let listed;
  try {
    listed = await listRecent(opts.days ?? 7);
  } catch (err) {
    summary.errors.push(`could not list recordings: ${err instanceof Error ? err.message : String(err)}`);
    return summary;
  }
  summary.checked = listed.length;

  for (const item of listed) {
    const existing = await db.query.recordings.findFirst({
      where: and(eq(recordings.source, "plaud"), eq(recordings.externalId, item.externalId)),
      columns: { id: true },
    });
    if (existing) continue;

    let best: Awaited<ReturnType<typeof fetchBestTranscript>>;
    try {
      best = await fetchBestTranscript(item.externalId);
    } catch (err) {
      summary.errors.push(`${item.externalId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!best?.text.trim()) {
      // Not transcribed yet; it is listed again next run.
      log(`[plaud] "${item.title}" has no transcript yet`);
      continue;
    }
    const transcript = best.text;

    const match = await matchRecording({ title: item.title, transcript });
    const [row] = await db
      .insert(recordings)
      .values({
        externalId: item.externalId,
        source: "plaud",
        title: item.title,
        transcript,
        transcriptPolished: best.polished,
        polishCheckedAt: new Date(),
        recordedAt: item.date ? new Date(`${item.date}T00:00:00Z`) : null,
        durationSeconds: item.durationSeconds,
        status: match ? "attached" : "review",
        contactId: match?.contactId ?? null,
        leadId: match?.leadId ?? null,
        matchedBy: match?.matchedBy ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: recordings.id });
    if (!row) continue; // another run beat us to it

    summary.imported++;
    if (match) {
      summary.attached++;
      if (match.contactId) {
        await logActivity({
          entity: "contact",
          entityId: match.contactId,
          actorId: null,
          action: "recording_attached",
          detail: { recordingId: row.id, title: item.title, matchedBy: match.matchedBy },
        });
      }
      log(`[plaud] "${item.title}" attached (${match.matchedBy})`);
    } else {
      summary.review++;
      log(`[plaud] "${item.title}" waiting in review`);
    }
  }

  await upgradeToCleanedTranscripts(summary, log);
  return summary;
}

/**
 * Swap original transcripts for Plaud's cleaned-up ones once they exist. Covers recordings imported
 * before this was added, and new ones Plaud had not finished cleaning up when they were imported.
 * A recording still waiting in review is matched again, since the cleaned text often reads the
 * name or number more clearly. Nothing already filed is moved.
 */
export async function upgradeToCleanedTranscripts(summary: ImportSummary, log: (m: string) => void = () => {}) {
  const now = Date.now();
  const due = await db.query.recordings.findMany({
    where: and(
      eq(recordings.source, "plaud"),
      eq(recordings.transcriptPolished, false),
      or(
        // Never asked (everything imported before cleaned transcripts were fetched)…
        isNull(recordings.polishCheckedAt),
        // …or recent, and not asked for a while.
        and(gt(recordings.createdAt, new Date(now - POLISH_RETRY_DAYS * 86400000)), lt(recordings.polishCheckedAt, new Date(now - POLISH_RETRY_HOURS * 3600000))),
      ),
    ),
    orderBy: [desc(recordings.createdAt)],
    limit: POLISH_BATCH,
  });

  for (const r of due) {
    let cleaned: string | null;
    try {
      cleaned = await fetchTranscript(r.externalId, { polished: true });
    } catch (err) {
      summary.errors.push(`${r.externalId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!cleaned) {
      await db.update(recordings).set({ polishCheckedAt: new Date() }).where(eq(recordings.id, r.id));
      continue;
    }
    const patch: Partial<typeof recordings.$inferInsert> = { transcript: cleaned, transcriptPolished: true, polishCheckedAt: new Date(), updatedAt: new Date() };
    const match = r.status === "review" ? await matchRecording({ title: r.title, transcript: cleaned }) : null;
    if (match) Object.assign(patch, { status: "attached", contactId: match.contactId, leadId: match.leadId, matchedBy: match.matchedBy });
    await db.update(recordings).set(patch).where(eq(recordings.id, r.id));
    summary.cleaned++;
    if (match?.contactId) {
      await logActivity({ entity: "contact", entityId: match.contactId, actorId: null, action: "recording_attached", detail: { recordingId: r.id, title: r.title, matchedBy: match.matchedBy } });
    }
    log(`[plaud] "${r.title}" now has the cleaned-up transcript${match ? ` and was filed (${match.matchedBy})` : ""}`);
  }
}
