/**
 * Two-way sync between the CRM calendar and a CalDAV calendar (the Titan calendar).
 *
 * Every CRM event that is copied out gets a stable UID (crm-<event id>@getsecure-crm) and a row in
 * calendar_items that remembers the calendar's href, ETag and the CRM version it matches. That row
 * is what stops an event being created twice: a CRM event with a row is updated in place, and a
 * calendar object whose UID is already known is never imported again.
 *
 * One pass:
 *   1. Pull. Skipped when the calendar's change tag (CTag) has not moved since last time, which
 *      keeps an idle sync to a single small request. Otherwise the events in the window are read:
 *      new ones become CRM events, changed ones update their CRM event, missing ones are removed.
 *   2. Push. CRM events that changed since they were last in step are written with If-Match on the
 *      ETag, so an edit made in the calendar in the meantime is never overwritten blind. Deleted CRM
 *      events are deleted from the calendar.
 *
 * When both sides changed the same event, the later edit wins.
 */
import { and, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections, calendarItems, events, jobs, type CalendarConnection, type CalendarItem } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { logActivity } from "@/lib/activity";
import { EVENT_KIND_LABELS, type EventKind } from "@/lib/constants";
import { calendarRef, connectCalDav, type DavClient } from "./caldav";
import { crmEventUid, patchCalendarEvent, readCalendarObject, writeCrmEvent, type CalendarInstance } from "./ics";

const PAST_DAYS = 60;
const FUTURE_DAYS = 400;

export type CalendarSyncSummary = {
  pulled: { created: number; updated: number; deleted: number };
  pushed: { created: number; updated: number; deleted: number };
  conflicts: number;
  skippedPull: boolean;
  errors: string[];
};

function appTz(): string {
  return process.env.APP_TIMEZONE || "Pacific/Auckland";
}

function appUrl(): string {
  return (process.env.APP_URL || "").replace(/\/+$/, "");
}

const key = (uid: string, recurrenceId: string) => `${uid}\u0000${recurrenceId}`;
const ms = (d: Date | null | undefined) => (d ? d.getTime() : 0);

type EventWithLinks = NonNullable<Awaited<ReturnType<typeof loadEvent>>>;

async function loadEvent(id: string) {
  return db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      job: { columns: { id: true, number: true, title: true }, with: { contact: { columns: { name: true } } } },
      lead: { columns: { id: true, name: true } },
      contact: { columns: { id: true, name: true } },
    },
  });
}

/** Where a CRM event leads, and a line saying what it is, for the calendar's description. */
function linkFor(ev: EventWithLinks): { link: string | null; context: string | null } {
  const base = appUrl();
  if (ev.job) return { link: base ? `${base}/jobs/${ev.job.id}` : null, context: `Job J-${ev.job.number}: ${ev.job.title} (${ev.job.contact.name})` };
  if (ev.lead) return { link: base ? `${base}/leads/${ev.lead.id}` : null, context: `${ev.kind === "site_visit" ? "Site visit" : "Appointment"} for ${ev.lead.name}` };
  if (ev.contact) return { link: base ? `${base}/contacts/${ev.contact.id}` : null, context: `Appointment with ${ev.contact.name}` };
  return { link: null, context: null };
}

function icsFor(ev: EventWithLinks, item: CalendarItem | null): string {
  if (item && item.origin === "calendar" && item.ics) {
    return patchCalendarEvent(item.ics, ev, appTz());
  }
  const { link, context } = linkFor(ev);
  return writeCrmEvent(
    {
      id: ev.id,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      allDay: ev.allDay,
      updatedAt: ev.updatedAt,
      kindLabel: EVENT_KIND_LABELS[ev.kind as EventKind] ?? "Appointment",
      link,
      context,
    },
    { uid: item?.uid ?? crmEventUid(ev.id), appTz: appTz(), existing: item?.ics ?? null },
  );
}

function hrefIn(calendarUrl: string, uid: string): string {
  return `${calendarUrl.replace(/\/?$/, "/")}${encodeURIComponent(uid)}.ics`;
}

/** Did anything the calendar controls actually change? Avoids touching events for no reason. */
function differs(ev: { title: string; description: string | null; location: string | null; startsAt: Date; endsAt: Date; allDay: boolean }, inst: CalendarInstance) {
  return (
    ev.title !== inst.title ||
    (ev.description ?? null) !== inst.description ||
    (ev.location ?? null) !== inst.location ||
    ms(ev.startsAt) !== ms(inst.startsAt) ||
    ms(ev.endsAt) !== ms(inst.endsAt) ||
    ev.allDay !== inst.allDay
  );
}

/** Apply a calendar edit to its CRM event, and record it on the job or lead it belongs to. */
async function applyRemote(ev: EventWithLinks, inst: CalendarInstance): Promise<Date> {
  const moved = ms(ev.startsAt) !== ms(inst.startsAt) || ms(ev.endsAt) !== ms(inst.endsAt);
  const updatedAt = new Date();
  await db
    .update(events)
    .set({
      title: inst.title,
      // The CRM's own events keep their description; the calendar copy carries extra link text.
      description: inst.description ?? (ev.fromCalendar ? null : ev.description),
      location: inst.location,
      startsAt: inst.startsAt,
      endsAt: inst.endsAt,
      allDay: inst.allDay,
      updatedAt,
    })
    .where(eq(events.id, ev.id));
  if (moved) {
    const detail = { startsAt: inst.startsAt.toISOString(), endsAt: inst.endsAt.toISOString(), via: "Titan calendar" };
    if (ev.jobId) await logActivity({ entity: "job", entityId: ev.jobId, actorId: null, action: "rescheduled", detail });
    else if (ev.leadId) await logActivity({ entity: "lead", entityId: ev.leadId, actorId: null, action: "site_visit_moved", detail: { ...detail, eventId: ev.id } });
  }
  return updatedAt;
}

/** The calendar event is gone: remove the CRM event too (a job goes back to unscheduled). */
async function applyRemoteDelete(ev: EventWithLinks) {
  await db.transaction(async (tx) => {
    await tx.delete(events).where(eq(events.id, ev.id));
    if (ev.jobId) {
      const remaining = await tx.query.events.findFirst({ where: eq(events.jobId, ev.jobId), columns: { id: true } });
      if (!remaining) await tx.update(jobs).set({ status: "unscheduled", updatedAt: new Date() }).where(and(eq(jobs.id, ev.jobId), eq(jobs.status, "scheduled")));
    }
  });
  const detail = { via: "Titan calendar", title: ev.title, startsAt: ev.startsAt.toISOString() };
  if (ev.jobId) await logActivity({ entity: "job", entityId: ev.jobId, actorId: null, action: "unscheduled", detail });
  else if (ev.leadId) await logActivity({ entity: "lead", entityId: ev.leadId, actorId: null, action: "site_visit_cancelled", detail });
}

async function pull(client: DavClient, conn: CalendarConnection, summary: CalendarSyncSummary) {
  const now = Date.now();
  const window = { from: new Date(now - PAST_DAYS * 86400000), to: new Date(now + FUTURE_DAYS * 86400000) };
  const objects = await client.fetchCalendarObjects({
    calendar: calendarRef(conn.calendarUrl),
    timeRange: { start: window.from.toISOString(), end: window.to.toISOString() },
  });

  const items = await db.query.calendarItems.findMany({ where: eq(calendarItems.connectionId, conn.id) });
  const byKey = new Map(items.map((i) => [key(i.uid, i.recurrenceId), i]));
  const seen = new Set<string>();

  for (const obj of objects) {
    if (!obj.data) continue;
    let instances: CalendarInstance[];
    try {
      instances = readCalendarObject(obj.data, window, appTz());
    } catch (err) {
      summary.errors.push(`could not read ${obj.url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const inst of instances) {
      if (inst.cancelled) continue;
      const k = key(inst.uid, inst.recurrenceId);
      seen.add(k);
      const item = byKey.get(k);

      if (!item) {
        // Our own event whose pairing row was lost: pair it again rather than import a copy.
        const crmId = inst.crmEventId && /^[0-9a-f-]{36}$/i.test(inst.crmEventId) ? inst.crmEventId : null;
        const own = crmId ? await loadEvent(crmId) : null;
        if (own) {
          await db
            .insert(calendarItems)
            .values({ connectionId: conn.id, eventId: own.id, uid: inst.uid, recurrenceId: inst.recurrenceId, href: obj.url, etag: obj.etag ?? null, origin: "crm", ics: obj.data, syncedVersion: own.updatedAt })
            .onConflictDoNothing();
          continue;
        }
        // Made in the CRM, since deleted there: leave it for the push step to delete.
        if (crmId) {
          await db
            .insert(calendarItems)
            .values({ connectionId: conn.id, eventId: null, uid: inst.uid, recurrenceId: inst.recurrenceId, href: obj.url, etag: obj.etag ?? null, origin: "crm", ics: obj.data })
            .onConflictDoNothing();
          continue;
        }
        const [ev] = await db
          .insert(events)
          .values({
            title: inst.title,
            description: inst.description,
            location: inst.location,
            startsAt: inst.startsAt,
            endsAt: inst.endsAt,
            allDay: inst.allDay,
            kind: "other",
            fromCalendar: true,
            readOnly: inst.recurring,
          })
          .returning({ id: events.id, updatedAt: events.updatedAt });
        await db
          .insert(calendarItems)
          .values({ connectionId: conn.id, eventId: ev.id, uid: inst.uid, recurrenceId: inst.recurrenceId, href: obj.url, etag: obj.etag ?? null, origin: "calendar", ics: inst.recurring ? null : obj.data, syncedVersion: ev.updatedAt })
          .onConflictDoNothing();
        summary.pulled.created++;
        continue;
      }

      if (item.etag && obj.etag && item.etag === obj.etag) continue;
      if (!item.eventId) {
        await db.update(calendarItems).set({ etag: obj.etag ?? null, href: obj.url, updatedAt: new Date() }).where(eq(calendarItems.id, item.id));
        continue;
      }
      const ev = await loadEvent(item.eventId);
      if (!ev) continue;
      const localChanged = ms(ev.updatedAt) > ms(item.syncedVersion);
      if (localChanged && !(inst.lastModified && inst.lastModified > ev.updatedAt)) {
        // Both sides changed and the CRM's edit is the later one: keep it, push it over the top.
        summary.conflicts++;
        await db.update(calendarItems).set({ etag: obj.etag ?? null, href: obj.url, ics: inst.recurring ? item.ics : obj.data, updatedAt: new Date() }).where(eq(calendarItems.id, item.id));
        continue;
      }
      let version = ev.updatedAt;
      if (differs(ev, inst)) {
        version = await applyRemote(ev, inst);
        summary.pulled.updated++;
      }
      await db
        .update(calendarItems)
        .set({ etag: obj.etag ?? null, href: obj.url, ics: inst.recurring ? item.ics : obj.data, syncedVersion: version, updatedAt: new Date() })
        .where(eq(calendarItems.id, item.id));
    }
  }

  // Anything we had that the calendar no longer holds was deleted there. Events outside the window
  // were simply not asked for, so they are left alone.
  for (const item of items) {
    if (seen.has(key(item.uid, item.recurrenceId))) continue;
    if (!item.eventId) {
      await db.delete(calendarItems).where(eq(calendarItems.id, item.id));
      continue;
    }
    const ev = await loadEvent(item.eventId);
    if (!ev) {
      await db.delete(calendarItems).where(eq(calendarItems.id, item.id));
      continue;
    }
    if (ev.endsAt < window.from || ev.startsAt > window.to) continue;
    await applyRemoteDelete(ev);
    await db.delete(calendarItems).where(eq(calendarItems.id, item.id));
    summary.pulled.deleted++;
  }
}

async function push(client: DavClient, conn: CalendarConnection, summary: CalendarSyncSummary) {
  const since = new Date(Date.now() - PAST_DAYS * 86400000);
  const kinds = conn.pushKinds.length ? conn.pushKinds : ["site_visit", "job", "other"];
  const candidates = await db
    .select({ id: events.id })
    .from(events)
    .where(and(gte(events.endsAt, since), eq(events.readOnly, false), or(inArray(events.kind, kinds as EventKind[]), eq(events.fromCalendar, true))));
  const items = await db.query.calendarItems.findMany({ where: and(eq(calendarItems.connectionId, conn.id), isNotNull(calendarItems.eventId)) });
  const byEvent = new Map(items.map((i) => [i.eventId!, i]));

  for (const { id } of candidates) {
    const item = byEvent.get(id) ?? null;
    const ev = await loadEvent(id);
    if (!ev) continue;
    if (item && ms(ev.updatedAt) <= ms(item.syncedVersion)) continue;
    if (!item && ev.fromCalendar) continue;

    const data = icsFor(ev, item);
    try {
      if (!item) {
        const uid = crmEventUid(ev.id);
        const res = await client.createCalendarObject({ calendar: calendarRef(conn.calendarUrl), filename: `${encodeURIComponent(uid)}.ics`, iCalString: data });
        if (res.status === 412) {
          // Already there (a previous sync wrote it but did not record it); the next pull pairs it.
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await db
          .insert(calendarItems)
          .values({ connectionId: conn.id, eventId: ev.id, uid, href: hrefIn(conn.calendarUrl, uid), etag: res.headers.get("etag"), origin: "crm", ics: data, syncedVersion: ev.updatedAt })
          .onConflictDoNothing();
        summary.pushed.created++;
      } else {
        let res = await client.updateCalendarObject({ calendarObject: { url: item.href, etag: item.etag ?? undefined, data } });
        if (res.status === 412) {
          // Changed in the calendar since we last looked. Leave it: the next pull decides who wins.
          summary.conflicts++;
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          res = await client.updateCalendarObject({ calendarObject: { url: item.href, data } });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await db.update(calendarItems).set({ etag: res.headers.get("etag"), ics: data, syncedVersion: ev.updatedAt, updatedAt: new Date() }).where(eq(calendarItems.id, item.id));
        summary.pushed.updated++;
      }
    } catch (err) {
      summary.errors.push(`could not save "${ev.title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // CRM events that were deleted: delete their calendar copy.
  const orphans = await db.query.calendarItems.findMany({ where: and(eq(calendarItems.connectionId, conn.id), isNull(calendarItems.eventId)) });
  for (const item of orphans) {
    try {
      let res = await client.deleteCalendarObject({ calendarObject: { url: item.href, etag: item.etag ?? undefined } });
      if (res.status === 412) res = await client.deleteCalendarObject({ calendarObject: { url: item.href } });
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`HTTP ${res.status}`);
      await db.delete(calendarItems).where(eq(calendarItems.id, item.id));
      summary.pushed.deleted++;
    } catch (err) {
      summary.errors.push(`could not delete ${item.href}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** One full sync of one connection. */
export async function syncCalendarConnection(connectionId: string, opts: { force?: boolean } = {}): Promise<CalendarSyncSummary> {
  const conn = await db.query.calendarConnections.findFirst({ where: eq(calendarConnections.id, connectionId) });
  if (!conn) throw new Error("Calendar connection not found");
  const summary: CalendarSyncSummary = { pulled: { created: 0, updated: 0, deleted: 0 }, pushed: { created: 0, updated: 0, deleted: 0 }, conflicts: 0, skippedPull: false, errors: [] };
  try {
    const client = await connectCalDav({ serverUrl: conn.serverUrl, username: conn.username, password: decryptSecret(conn.passwordEncrypted) });
    const dirty = await client.isCollectionDirty({ collection: { url: conn.calendarUrl, ctag: conn.ctag ?? undefined } });
    const newCtag = dirty.newCtag || null;
    if (opts.force || !conn.ctag || dirty.isDirty) await pull(client, conn, summary);
    else summary.skippedPull = true;
    await push(client, conn, summary);
    const pushed = summary.pushed.created + summary.pushed.updated + summary.pushed.deleted;
    // Our own writes move the CTag too. Forget it after writing, so the next pass reads the calendar
    // once more rather than risk missing an edit made in the calendar at the same moment.
    await db
      .update(calendarConnections)
      .set({ ctag: pushed ? null : newCtag, lastSyncAt: new Date(), lastError: summary.errors[0] ?? null, updatedAt: new Date() })
      .where(eq(calendarConnections.id, conn.id));
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(calendarConnections).set({ lastError: message, updatedAt: new Date() }).where(eq(calendarConnections.id, conn.id));
    throw err;
  }
}

// ---------- scheduling ----------

declare global {
  var __calendarSync: { running: Promise<unknown> | null; timer: ReturnType<typeof setTimeout> | null; lastRun: number } | undefined;
}

function state() {
  globalThis.__calendarSync ??= { running: null, timer: null, lastRun: 0 };
  return globalThis.__calendarSync;
}

/** Sync every active connection, one pass at a time (a second call waits for the first). */
export async function syncAllCalendars(log: (m: string) => void = () => {}, opts: { force?: boolean } = {}): Promise<Record<string, CalendarSyncSummary | { error: string }>> {
  const s = state();
  while (s.running) await s.running.catch(() => {});
  const run = (async () => {
    const out: Record<string, CalendarSyncSummary | { error: string }> = {};
    const conns = await db.query.calendarConnections.findMany({ where: eq(calendarConnections.active, true) });
    for (const c of conns) {
      try {
        out[c.name] = await syncCalendarConnection(c.id, opts);
        const r = out[c.name] as CalendarSyncSummary;
        const n = r.pulled.created + r.pulled.updated + r.pulled.deleted + r.pushed.created + r.pushed.updated + r.pushed.deleted;
        if (n) log(`[calendar ${c.name}] in +${r.pulled.created} ~${r.pulled.updated} -${r.pulled.deleted}, out +${r.pushed.created} ~${r.pushed.updated} -${r.pushed.deleted}`);
      } catch (err) {
        out[c.name] = { error: err instanceof Error ? err.message : String(err) };
        log(`[calendar ${c.name}] ${(out[c.name] as { error: string }).error}`);
      }
    }
    s.lastRun = Date.now();
    return out;
  })();
  s.running = run;
  try {
    return await run;
  } finally {
    s.running = null;
  }
}

/** Called by the background loop every minute; syncs when the interval has passed. */
export async function runCalendarSyncIfDue(intervalSeconds: number, log?: (m: string) => void) {
  if (Date.now() - state().lastRun < intervalSeconds * 1000) return null;
  return syncAllCalendars(log);
}

/**
 * Push a CRM change out soon, rather than waiting for the next scheduled pass. Several changes in
 * quick succession become one sync. Never throws: the scheduled pass is the backstop.
 */
export function queueCalendarSync(delayMs = 1500) {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void db.query.calendarConnections
      .findFirst({ where: eq(calendarConnections.active, true), columns: { id: true } })
      .then((c) => (c ? syncAllCalendars((m) => console.log(m)) : null))
      .catch((err) => console.error(`[calendar] ${err instanceof Error ? err.message : String(err)}`));
  }, delayMs);
}
