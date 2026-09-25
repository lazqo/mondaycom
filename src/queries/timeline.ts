import "server-only";
/**
 * The complete history of a relationship, as one chronological list.
 *
 * A lead's timeline covers the lead and everything that grew out of it: its emails in both
 * directions, notes and calls, status changes, reminders, site visits and appointments, and the
 * quotes and jobs made from it (with their status changes, notes and photos). A customer's
 * timeline is the same thing across all of their leads, quotes and jobs, plus anything recorded
 * against the customer directly. Nothing is copied on conversion; both views are read from the
 * same rows, so converting a lead cannot lose or split its history.
 */
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  activityLog,
  contacts,
  emailThreads,
  emails,
  events,
  jobNotes,
  jobPhotos,
  jobs,
  leads,
  quotes,
  recordings,
  tasks,
  users,
  type EmailAddress,
} from "@/db/schema";
import { JOB_STATUS_META, LEAD_SOURCE_LABELS, LEAD_STATUS_META, QUOTE_STATUS_META, type JobStatus, type LeadStatus, type QuoteStatus } from "@/lib/constants";
import { stripQuotedReply } from "@/lib/email/parse";
import { zonedToUtc } from "@/lib/calendar/ics";
import { formatDate, formatDateOnly, formatDateTime, formatMoney, formatTime } from "@/lib/utils";
import { isWebsiteLeadSender } from "@/lib/email/website-lead";

export type TimelineKind =
  | "enquiry"
  | "email_in"
  | "email_out"
  | "note"
  | "call"
  | "status"
  | "follow_up"
  | "site_visit"
  | "appointment"
  | "quote"
  | "job"
  | "photo"
  | "recording"
  | "activity";

export type TimelineAttachment = { id: string; name: string; href: string; size: number; image: boolean };

export type TimelineItem = {
  id: string;
  at: Date;
  kind: TimelineKind;
  title: string;
  /** Short secondary line: times, amounts, who it was assigned to. */
  meta?: string | null;
  /** Long text: an email body, a note, a transcript. */
  body?: string | null;
  /** The whole email including the quoted history, when it differs from body. */
  fullBody?: string | null;
  /** The member of staff who did it; null for things the CRM or a customer did. */
  actor?: string | null;
  href?: string | null;
  /** Which record it belongs to, shown on a customer's timeline ("Lead: Dave", "J-12"). */
  source?: string | null;
  upcoming?: boolean;
  email?: { from: string; to: string; cc: string; subject: string; via: "inbox" | "crm" | "sent_folder"; threadId: string };
  attachments?: TimelineAttachment[];
};

const NONE = "00000000-0000-0000-0000-000000000000";
const ids = (list: string[]) => (list.length ? list : [NONE]);

function addr(a: EmailAddress) {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function leadStatusLabel(s: unknown): string {
  return typeof s === "string" && s in LEAD_STATUS_META ? LEAD_STATUS_META[s as LeadStatus].label : String(s ?? "");
}
function jobStatusLabel(s: unknown): string {
  return typeof s === "string" && s in JOB_STATUS_META ? JOB_STATUS_META[s as JobStatus].label : String(s ?? "");
}
function quoteStatusLabel(s: unknown): string {
  return typeof s === "string" && s in QUOTE_STATUS_META ? QUOTE_STATUS_META[s as QuoteStatus].label : String(s ?? "");
}

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  company: "company",
  phone: "phone",
  email: "email",
  service: "service",
  site: "site address",
  assignedToId: "assigned to",
  lastContactAt: "last contact",
  source: "source",
  notes: "notes",
  summary: "summary",
  urgency: "urgency",
  nextAction: "next action",
  title: "title",
  siteAddress: "site address",
  address: "address",
};

function fmtValue(v: unknown, userNames: Map<string, string>): string {
  if (v === null || v === undefined || v === "") return "blank";
  if (typeof v === "string" && userNames.has(v)) return userNames.get(v)!;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDateOnly(v);
  return String(v);
}

type Scope = { leadIds: string[]; contactId: string | null; label: boolean };

async function buildTimeline(scope: Scope): Promise<TimelineItem[]> {
  const leadRows = scope.leadIds.length
    ? await db.query.leads.findMany({ where: inArray(leads.id, scope.leadIds), with: { contact: { columns: { id: true, name: true } } } })
    : [];
  const leadIds = leadRows.map((l) => l.id);

  const quoteRows = await db.query.quotes.findMany({
    where: or(inArray(quotes.leadId, ids(leadIds)), scope.contactId ? eq(quotes.contactId, scope.contactId) : sql`false`),
  });
  const quoteIds = quoteRows.map((q) => q.id);
  const jobRows = await db.query.jobs.findMany({
    where: or(inArray(jobs.leadId, ids(leadIds)), inArray(jobs.quoteId, ids(quoteIds)), scope.contactId ? eq(jobs.contactId, scope.contactId) : sql`false`),
  });
  const jobIds = jobRows.map((j) => j.id);
  const threadFilter: SQL[] = [inArray(emailThreads.leadId, ids(leadIds)), inArray(emailThreads.jobId, ids(jobIds))];
  const leadThreadIds = leadRows.map((l) => l.emailThreadId).filter((x): x is string => !!x);
  if (leadThreadIds.length) threadFilter.push(inArray(emailThreads.id, leadThreadIds));
  if (scope.contactId) threadFilter.push(eq(emailThreads.contactId, scope.contactId));

  const [eventRows, threadRows, recordingRows, taskRows, noteRows, photoRows, userRows] = await Promise.all([
    db.query.events.findMany({
      where: or(inArray(events.leadId, ids(leadIds)), inArray(events.jobId, ids(jobIds)), scope.contactId ? eq(events.contactId, scope.contactId) : sql`false`),
      with: { assignedTo: { columns: { name: true } } },
    }),
    db.query.emailThreads.findMany({
      where: or(...threadFilter),
      with: {
        emails: {
          orderBy: [asc(emails.receivedAt)],
          with: { attachments: { columns: { id: true, filename: true, size: true, contentType: true } }, sentBy: { columns: { name: true } } },
        },
      },
    }),
    db.query.recordings.findMany({
      where: and(or(inArray(recordings.leadId, ids(leadIds)), scope.contactId ? eq(recordings.contactId, scope.contactId) : sql`false`), sql`${recordings.status} <> 'dismissed'`),
    }),
    db.query.tasks.findMany({
      where: or(
        inArray(tasks.leadId, ids(leadIds)),
        inArray(tasks.quoteId, ids(quoteIds)),
        inArray(tasks.jobId, ids(jobIds)),
        scope.contactId ? eq(tasks.contactId, scope.contactId) : sql`false`,
      ),
    }),
    db.query.jobNotes.findMany({ where: inArray(jobNotes.jobId, ids(jobIds)) }),
    db.query.jobPhotos.findMany({ where: inArray(jobPhotos.jobId, ids(jobIds)), columns: { id: true, jobId: true, uploadedById: true, filename: true, size: true, caption: true, createdAt: true } }),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);
  const eventIds = eventRows.map((e) => e.id);
  const activity = await db
    .select()
    .from(activityLog)
    .where(
      or(
        and(eq(activityLog.entity, "lead"), inArray(activityLog.entityId, ids(leadIds))),
        and(eq(activityLog.entity, "quote"), inArray(activityLog.entityId, ids(quoteIds))),
        and(eq(activityLog.entity, "job"), inArray(activityLog.entityId, ids(jobIds))),
        and(eq(activityLog.entity, "event"), inArray(activityLog.entityId, ids(eventIds))),
        scope.contactId ? and(eq(activityLog.entity, "contact"), eq(activityLog.entityId, scope.contactId)) : sql`false`,
      ),
    )
    .orderBy(asc(activityLog.createdAt));

  const names = new Map(userRows.map((u) => [u.id, u.name]));
  const who = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  const leadById = new Map(leadRows.map((l) => [l.id, l]));
  const quoteById = new Map(quoteRows.map((q) => [q.id, q]));
  const jobById = new Map(jobRows.map((j) => [j.id, j]));
  const leadLabel = (id: string | null | undefined) => (scope.label && id && leadById.has(id) ? `Lead: ${leadById.get(id)!.name}` : null);
  const quoteLabel = (id: string) => (scope.label ? `Q-${quoteById.get(id)?.number ?? "?"}` : null);
  const jobLabel = (id: string) => (scope.label ? `J-${jobById.get(id)?.number ?? "?"}` : null);

  const items: TimelineItem[] = [];
  const sourceEmailIds = new Set(leadRows.map((l) => l.sourceEmailId).filter((x): x is string => !!x));
  const emailById = new Map(threadRows.flatMap((t) => t.emails.map((m) => [m.id, { ...m, threadId: t.id }] as const)));

  const emailFields = (m: (typeof threadRows)[number]["emails"][number], threadId: string) => {
    const full = m.textBody ?? "";
    const fresh = m.direction === "inbound" || m.origin === "sent_folder" ? stripQuotedReply(full) : full;
    return {
      body: fresh || full || m.snippet || null,
      fullBody: fresh && fresh.trim() !== full.trim() ? full : null,
      email: {
        from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
        to: m.to.map(addr).join(", "),
        cc: m.cc.map(addr).join(", "),
        subject: m.subject || "(no subject)",
        via: m.origin,
        threadId,
      },
      attachments: m.attachments.map((a) => ({ id: a.id, name: a.filename, href: `/api/attachments/${a.id}`, size: a.size, image: a.contentType.startsWith("image/") })),
      href: `/inbox/${threadId}`,
    };
  };

  // ---- Leads: the enquiry that started each one ----
  const creators = new Map<string, string | null>();
  for (const a of activity) {
    if (a.entity === "lead" && ["created", "created_from_email", "auto_created_from_email"].includes(a.action) && !creators.has(a.entityId)) creators.set(a.entityId, who(a.actorId));
  }
  for (const l of leadRows) {
    const src = l.sourceEmailId ? emailById.get(l.sourceEmailId) : undefined;
    const actor = creators.get(l.id) ?? who(l.createdById);
    const via = src ? (isWebsiteLeadSender(src.fromAddress) ? "Website enquiry form" : "By email") : `Source: ${LEAD_SOURCE_LABELS[l.source]}`;
    const srcFields = src ? emailFields(src, src.threadId) : null;
    items.push({
      id: `enquiry-${l.id}`,
      at: src?.receivedAt ?? l.createdAt,
      kind: "enquiry",
      title: src ? `Enquiry received${l.service ? `: ${l.service}` : ""}` : `Lead added${l.service ? `: ${l.service}` : ""}`,
      meta: [via, l.site, l.phone].filter(Boolean).join(" · "),
      body: l.summary ?? srcFields?.body ?? l.notes,
      fullBody: srcFields ? (srcFields.fullBody ?? srcFields.body) : null,
      actor,
      href: `/leads/${l.id}`,
      source: leadLabel(l.id),
      ...(srcFields ? { email: srcFields.email, attachments: srcFields.attachments } : {}),
    });
    // The next follow-up, if one is set and still ahead.
    if (l.followUpAt && !l.archivedAt && !["won", "lost"].includes(l.status)) {
      const [y, mo, d] = l.followUpAt.split("-").map(Number);
      const at = zonedToUtc({ year: y, month: mo, day: d, hour: 9 }, process.env.APP_TIMEZONE || "Pacific/Auckland");
      if (at.getTime() > Date.now() - 86400000) {
        items.push({ id: `followup-next-${l.id}`, at, kind: "follow_up", title: "Follow-up due", meta: formatDateOnly(l.followUpAt), upcoming: at > new Date(), href: `/leads/${l.id}`, source: leadLabel(l.id) });
      }
    }
  }

  // ---- Emails, both directions ----
  const seenEmail = new Set<string>();
  for (const t of threadRows) {
    for (const m of t.emails) {
      if (seenEmail.has(m.id) || sourceEmailIds.has(m.id)) continue;
      seenEmail.add(m.id);
      const f = emailFields(m, t.id);
      const outbound = m.direction === "outbound";
      const firstTo = m.to[0] ? (m.to[0].name ?? m.to[0].address) : "";
      items.push({
        id: `email-${m.id}`,
        at: m.receivedAt,
        kind: outbound ? "email_out" : "email_in",
        title: outbound ? `Email sent to ${firstTo || "customer"}` : `Email from ${m.fromName ?? m.fromAddress}`,
        meta: m.subject || "(no subject)",
        actor: outbound ? (m.sentBy?.name ?? null) : null,
        source: leadLabel(t.leadId) ?? (t.jobId && jobById.has(t.jobId) ? jobLabel(t.jobId) : null),
        ...f,
      });
    }
  }

  // ---- Activity log ----
  for (const a of activity) {
    const d = (a.detail ?? {}) as Record<string, unknown>;
    const actor = who(a.actorId);
    const base = { id: `act-${a.id}`, at: a.createdAt, actor };
    const viaCalendar = d.via === "Titan calendar";

    if (a.entity === "lead") {
      const src = leadLabel(a.entityId);
      const href = `/leads/${a.entityId}`;
      switch (a.action) {
        case "created":
        case "created_from_email":
        case "auto_created_from_email":
        case "email_received":
        case "recording_attached":
          continue; // shown by the enquiry, email and recording entries themselves
        case "note":
          items.push({ ...base, kind: "note", title: "Note", body: String(d.body ?? ""), source: src, href });
          continue;
        case "call":
          items.push({ ...base, kind: "call", title: d.direction === "incoming" ? "Phone call from the customer" : "Phone call to the customer", meta: d.outcome ? String(d.outcome) : null, body: String(d.body ?? "") || null, source: src, href });
          continue;
        case "status_changed": {
          const changes = (d.changes as Record<string, { from?: unknown; to?: unknown }> | undefined) ?? {};
          const st = changes.status;
          const title = st?.from ? `Status changed: ${leadStatusLabel(st.from)} → ${leadStatusLabel(st.to)}` : `Status changed to ${leadStatusLabel(st?.to ?? d.to)}`;
          items.push({ ...base, kind: "status", title, meta: d.via ? `Because of ${String(d.via)}` : null, source: src, href });
          const rest = Object.keys(changes).filter((k) => k !== "status" && k !== "followUpAt");
          if (rest.length) items.push({ ...base, id: `${base.id}-u`, kind: "activity", title: `Updated ${rest.map((k) => FIELD_LABELS[k] ?? k).join(", ")}`, source: src, href });
          if (changes.followUpAt) items.push({ ...base, id: `${base.id}-f`, kind: "follow_up", title: changes.followUpAt.to ? `Follow-up set for ${fmtValue(changes.followUpAt.to, names)}` : "Follow-up cleared", source: src, href });
          continue;
        }
        case "updated": {
          const changes = (d.changes as Record<string, { from?: unknown; to?: unknown }> | undefined) ?? {};
          if (changes.followUpAt) {
            items.push({ ...base, id: `${base.id}-f`, kind: "follow_up", title: changes.followUpAt.to ? `Follow-up set for ${fmtValue(changes.followUpAt.to, names)}` : "Follow-up cleared", source: src, href });
          }
          const rest = Object.keys(changes).filter((k) => k !== "followUpAt" && k !== "updatedAt");
          if (rest.length) {
            items.push({
              ...base,
              kind: "activity",
              title: `Updated ${rest.map((k) => FIELD_LABELS[k] ?? k).join(", ")}`,
              body: rest.map((k) => `${FIELD_LABELS[k] ?? k}: ${fmtValue(changes[k]?.from, names)} → ${fmtValue(changes[k]?.to, names)}`).join("\n"),
              source: src,
              href,
            });
          }
          continue;
        }
        case "converted": {
          const cName = leadById.get(a.entityId)?.contact?.name;
          items.push({ ...base, kind: "status", title: `Converted to customer${cName ? ` ${cName}` : ""}`, href: d.contactId ? `/contacts/${String(d.contactId)}` : href, source: src });
          continue;
        }
        case "site_visit_scheduled": {
          const when = d.startsAt ? formatDateTime(String(d.startsAt)) : null;
          items.push({ ...base, kind: "site_visit", title: `Site visit booked${when ? ` for ${when}` : ""}`, source: src, href });
          continue;
        }
        case "site_visit_moved":
          items.push({ ...base, kind: "site_visit", title: `Site visit moved to ${d.startsAt ? formatDateTime(String(d.startsAt)) : "a new time"}`, meta: viaCalendar ? "Changed in the Titan calendar" : null, source: src, href });
          continue;
        case "site_visit_cancelled":
          items.push({ ...base, kind: "site_visit", title: "Site visit removed", meta: viaCalendar ? "Deleted in the Titan calendar" : null, source: src, href });
          continue;
        case "email_linked":
          items.push({ ...base, kind: "activity", title: `Linked the conversation "${String(d.subject ?? "")}"`, href: d.threadId ? `/inbox/${String(d.threadId)}` : href, source: src });
          continue;
        case "archived":
          items.push({ ...base, kind: "status", title: "Lead archived", source: src, href });
          continue;
        default:
          items.push({ ...base, kind: "activity", title: a.action.replace(/_/g, " "), source: src, href });
          continue;
      }
    }

    if (a.entity === "quote") {
      const q = quoteById.get(a.entityId);
      if (!q) continue;
      const href = `/quotes/${q.id}`;
      if (a.action === "created") items.push({ ...base, kind: "quote", title: `Quote Q-${q.number} created: ${q.title}`, meta: formatMoney(q.total), href, source: quoteLabel(q.id) });
      else if (a.action === "status_changed") items.push({ ...base, kind: "quote", title: `Quote Q-${q.number} ${quoteStatusLabel(d.to).toLowerCase()}`, meta: formatMoney(q.total), href, source: quoteLabel(q.id) });
      else if (a.action === "updated") items.push({ ...base, kind: "activity", title: `Quote Q-${q.number} edited`, href, source: quoteLabel(q.id) });
      continue;
    }

    if (a.entity === "job") {
      const j = jobById.get(a.entityId);
      if (!j) continue;
      const href = `/jobs/${j.id}`;
      const src = jobLabel(j.id);
      switch (a.action) {
        case "created":
          items.push({ ...base, kind: "job", title: `Job J-${j.number} created: ${j.title}`, meta: j.siteAddress, href, source: src });
          continue;
        case "status_changed":
          items.push({ ...base, kind: "job", title: `Job J-${j.number}: ${jobStatusLabel(d.status)}`, meta: d.from ? `was ${jobStatusLabel(d.from)}` : null, href, source: src });
          continue;
        case "scheduled":
          items.push({ ...base, kind: "job", title: `Job J-${j.number} scheduled for ${d.startsAt ? formatDateTime(String(d.startsAt)) : "a date"}`, meta: d.assignedToId ? `Assigned to ${who(String(d.assignedToId)) ?? "a technician"}` : null, href, source: src });
          continue;
        case "rescheduled":
          items.push({ ...base, kind: "job", title: `Job J-${j.number} moved to ${d.startsAt ? formatDateTime(String(d.startsAt)) : "a new time"}`, meta: viaCalendar ? "Changed in the Titan calendar" : null, href, source: src });
          continue;
        case "unscheduled":
          items.push({ ...base, kind: "job", title: `Job J-${j.number} unscheduled`, meta: viaCalendar ? "Deleted in the Titan calendar" : null, href, source: src });
          continue;
        case "updated": {
          const keys = Object.keys(d).filter((k) => !["updatedAt", "status"].includes(k));
          if (keys.length) items.push({ ...base, kind: "activity", title: `Job J-${j.number} updated: ${keys.map((k) => FIELD_LABELS[k] ?? k).join(", ")}`, href, source: src });
          continue;
        }
        default:
          items.push({ ...base, kind: "activity", title: `Job J-${j.number}: ${a.action.replace(/_/g, " ")}`, href, source: src });
          continue;
      }
    }

    if (a.entity === "contact") {
      const href = scope.contactId ? `/contacts/${scope.contactId}` : null;
      if (a.action === "note") items.push({ ...base, kind: "note", title: "Note", body: String(d.body ?? ""), href });
      else if (a.action === "call") items.push({ ...base, kind: "call", title: d.direction === "incoming" ? "Phone call from the customer" : "Phone call to the customer", meta: d.outcome ? String(d.outcome) : null, body: String(d.body ?? "") || null, href });
      else if (a.action === "created") items.push({ ...base, kind: "activity", title: "Customer record created", href });
      else if (a.action === "updated") items.push({ ...base, kind: "activity", title: "Customer details updated", href });
      continue;
    }
    // "event" entries (created/updated in the calendar screen) are covered by the events themselves.
  }

  // ---- Quotes and jobs from before activity was logged for them ----
  const logged = new Set(activity.map((a) => `${a.entity}:${a.entityId}:${a.action}:${String((a.detail as { to?: unknown; status?: unknown } | null)?.to ?? (a.detail as { status?: unknown } | null)?.status ?? "")}`));
  const has = (prefix: string) => [...logged].some((k) => k.startsWith(prefix));
  for (const q of quoteRows) {
    const href = `/quotes/${q.id}`;
    if (!has(`quote:${q.id}:created`)) items.push({ id: `quote-${q.id}`, at: q.createdAt, kind: "quote", title: `Quote Q-${q.number} created: ${q.title}`, meta: formatMoney(q.total), href, source: quoteLabel(q.id) });
    if (q.sentAt && !has(`quote:${q.id}:status_changed:sent`)) items.push({ id: `quote-sent-${q.id}`, at: q.sentAt, kind: "quote", title: `Quote Q-${q.number} sent`, meta: formatMoney(q.total), href, source: quoteLabel(q.id) });
    if (q.acceptedAt && !has(`quote:${q.id}:status_changed:accepted`)) items.push({ id: `quote-acc-${q.id}`, at: q.acceptedAt, kind: "quote", title: `Quote Q-${q.number} accepted`, meta: formatMoney(q.total), href, source: quoteLabel(q.id) });
  }
  for (const j of jobRows) {
    const href = `/jobs/${j.id}`;
    if (!has(`job:${j.id}:created`)) items.push({ id: `job-${j.id}`, at: j.createdAt, kind: "job", title: `Job J-${j.number} created: ${j.title}`, meta: j.siteAddress, href, source: jobLabel(j.id) });
    if (j.doneAt && !has(`job:${j.id}:status_changed:done`)) items.push({ id: `job-done-${j.id}`, at: j.doneAt, kind: "job", title: `Job J-${j.number}: Done`, href, source: jobLabel(j.id) });
    if (j.invoicedAt && !has(`job:${j.id}:status_changed:invoiced`)) items.push({ id: `job-inv-${j.id}`, at: j.invoicedAt, kind: "job", title: `Job J-${j.number}: Invoiced`, href, source: jobLabel(j.id) });
  }

  // ---- Visits and appointments, placed when they happen ----
  const now = new Date();
  for (const e of eventRows) {
    const job = e.jobId ? jobById.get(e.jobId) : undefined;
    const kind: TimelineKind = e.kind === "site_visit" ? "site_visit" : "appointment";
    const title = e.kind === "site_visit" ? "Site visit" : job ? `Job J-${job.number} on site` : e.title;
    items.push({
      id: `event-${e.id}`,
      at: e.startsAt,
      kind,
      title,
      meta: [
        e.allDay ? `${formatDate(e.startsAt)} (all day)` : `${formatDateTime(e.startsAt)} – ${formatTime(e.endsAt)}`,
        e.assignedTo?.name,
        e.location,
        e.fromCalendar ? "from the Titan calendar" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      body: e.description,
      actor: who(e.createdById),
      upcoming: e.startsAt > now,
      href: job ? `/jobs/${job.id}` : e.leadId ? `/leads/${e.leadId}` : "/calendar",
      source: job ? jobLabel(job.id) : leadLabel(e.leadId),
    });
  }

  // ---- Reminders ----
  for (const t of taskRows) {
    const src = t.leadId ? leadLabel(t.leadId) : t.jobId ? jobLabel(t.jobId) : t.quoteId ? quoteLabel(t.quoteId) : null;
    items.push({
      id: `task-${t.id}`,
      at: t.createdAt,
      kind: "follow_up",
      title: `Reminder: ${t.title}`,
      meta: [t.dueAt ? `Due ${formatDateOnly(t.dueAt)}` : null, t.assignedToId ? `for ${who(t.assignedToId) ?? "staff"}` : null, t.status !== "open" ? t.status : null].filter(Boolean).join(" · ") || null,
      body: t.detail,
      actor: t.ruleKey ? null : who(t.createdById),
      source: src,
    });
    if (t.completedAt) items.push({ id: `task-done-${t.id}`, at: t.completedAt, kind: "follow_up", title: `Reminder ${t.status === "dismissed" ? "dismissed" : "done"}: ${t.title}`, source: src });
  }

  // ---- Job notes and photos ----
  for (const n of noteRows) {
    const j = jobById.get(n.jobId);
    items.push({ id: `jobnote-${n.id}`, at: n.createdAt, kind: "note", title: `Note on job J-${j?.number ?? "?"}`, body: n.body, actor: who(n.authorId), href: `/jobs/${n.jobId}`, source: jobLabel(n.jobId) });
  }
  const photosByJobMinute = new Map<string, typeof photoRows>();
  for (const p of photoRows) {
    const k = `${p.jobId}:${p.uploadedById ?? ""}:${Math.floor(p.createdAt.getTime() / 60000)}`;
    photosByJobMinute.set(k, [...(photosByJobMinute.get(k) ?? []), p]);
  }
  for (const [k, list] of photosByJobMinute) {
    const p = list[0];
    const j = jobById.get(p.jobId);
    items.push({
      id: `photos-${k}`,
      at: p.createdAt,
      kind: "photo",
      title: `${list.length} photo${list.length === 1 ? "" : "s"} added to job J-${j?.number ?? "?"}`,
      body: list.map((x) => x.caption).filter(Boolean).join("\n") || null,
      actor: who(p.uploadedById),
      href: `/jobs/${p.jobId}`,
      source: jobLabel(p.jobId),
      attachments: list.map((x) => ({ id: x.id, name: x.filename, href: `/api/photos/${x.id}`, size: x.size, image: true })),
    });
  }

  // ---- Voice recordings ----
  for (const r of recordingRows) {
    const minutes = r.durationSeconds ? `${Math.round(r.durationSeconds / 60)} min` : null;
    items.push({ id: `rec-${r.id}`, at: r.recordedAt ?? r.createdAt, kind: "recording", title: `Recorded conversation: ${r.title}`, meta: [minutes, "Plaud", r.transcriptPolished ? "cleaned-up transcript" : "original transcript"].filter(Boolean).join(" · "), body: r.transcript, source: leadLabel(r.leadId), href: "/recordings" });
  }

  // Oldest first; ties keep the order they were added (enquiry before the emails that follow it).
  return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.at.getTime() - b.it.at.getTime() || a.i - b.i).map((x) => x.it);
}

/** Everything that happened on one lead, and on the quotes and jobs made from it. */
export async function getLeadTimeline(leadId: string): Promise<TimelineItem[]> {
  return buildTimeline({ leadIds: [leadId], contactId: null, label: false });
}

/** Everything that happened with one customer, across all their leads, quotes and jobs. */
export async function getContactTimeline(contactId: string): Promise<TimelineItem[]> {
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId), columns: { id: true } });
  if (!contact) return [];
  const leadRows = await db.select({ id: leads.id }).from(leads).where(eq(leads.contactId, contactId));
  return buildTimeline({ leadIds: leadRows.map((l) => l.id), contactId, label: true });
}

/** For the browser: ISO dates plus the time already written out in the business's time zone. */
export function toTimelineEntries(items: TimelineItem[]): import("@/components/timeline/timeline").TimelineEntry[] {
  return items.map((it) => ({ ...it, at: it.at.toISOString(), when: formatDateTime(it.at) }));
}
