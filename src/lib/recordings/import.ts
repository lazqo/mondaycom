/**
 * Pulls new recordings from Plaud into the CRM. Idempotent: a recording already imported is
 * skipped, so the sync can run as often as you like.
 */
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { listRecent, fetchTranscript, plaudConfigured } from "./plaud";
import { matchRecording } from "./match";

export type ImportSummary = { checked: number; imported: number; attached: number; review: number; errors: string[] };

export async function importRecentRecordings(opts: { days?: number; log?: (m: string) => void } = {}): Promise<ImportSummary> {
  const log = opts.log ?? (() => {});
  const summary: ImportSummary = { checked: 0, imported: 0, attached: 0, review: 0, errors: [] };
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

    let transcript: string;
    try {
      transcript = await fetchTranscript(item.externalId);
    } catch (err) {
      summary.errors.push(`${item.externalId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!transcript.trim()) {
      summary.errors.push(`${item.externalId}: transcript was empty`);
      continue;
    }

    const match = await matchRecording({ title: item.title, transcript });
    const [row] = await db
      .insert(recordings)
      .values({
        externalId: item.externalId,
        source: "plaud",
        title: item.title,
        transcript,
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
  return summary;
}
