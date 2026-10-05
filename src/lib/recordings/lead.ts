/**
 * A lead from a recorded conversation: a new enquirer on a sales call or site chat, read by Hermes
 * (name, phone, service, site, what they want). The same shape as a lead from an email; the
 * recording is filed on it and the trail says where it came from.
 */
import { eq, max } from "drizzle-orm";
import { db } from "@/db";
import { leads, recordings, type ExtractedLead } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { dateInAppTz, nextBusinessDay } from "@/lib/email/pipeline";
import { personalEmail } from "@/lib/email/website-lead";

export async function createLeadFromRecording(recordingId: string, opts: { actorId: string | null; overrides?: Partial<ExtractedLead>; assignedToId?: string | null }): Promise<string> {
  const r = await db.query.recordings.findFirst({ where: eq(recordings.id, recordingId) });
  if (!r) throw new Error("Recording not found");
  const x = opts.overrides ?? {};
  const at = r.recordedAt ?? r.createdAt;
  return db.transaction(async (tx) => {
    const [{ maxPos }] = await tx.select({ maxPos: max(leads.position) }).from(leads);
    const [row] = await tx
      .insert(leads)
      .values({
        name: x.contact_name?.trim() || `Caller (${r.title})`,
        company: x.company ?? null,
        phone: x.phone ?? null,
        email: personalEmail(x.email ?? null),
        service: x.service ?? null,
        site: x.site_address ?? null,
        status: "new",
        source: "phone",
        summary: x.summary ?? null,
        urgency: x.urgency ?? "normal",
        nextAction: x.next_action ?? null,
        aiConfidence: x.confidence != null ? Number(x.confidence).toFixed(3) : null,
        assignedToId: opts.assignedToId ?? null,
        lastContactAt: dateInAppTz(at),
        followUpAt: nextBusinessDay(at),
        followUpSetAt: new Date(),
        notes: `From recorded conversation: ${r.title}`,
        position: (maxPos ?? 0) + 1,
        createdById: opts.actorId,
      })
      .returning({ id: leads.id });
    await tx.update(recordings).set({ leadId: row.id, status: "attached", matchedBy: "Hermes: new enquiry on this call", updatedAt: new Date() }).where(eq(recordings.id, recordingId));
    await logActivity({ entity: "lead", entityId: row.id, actorId: opts.actorId, action: opts.actorId ? "created_from_recording" : "auto_created_from_recording", detail: { recordingId, title: r.title, confidence: x.confidence ?? null, reason: x.reason ?? null } });
    return row.id;
  });
}
