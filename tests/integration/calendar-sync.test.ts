/**
 * Two-way calendar sync against a real CalDAV server (Radicale, standing in for Titan).
 * Start it with tests/support/caldav/start.sh; the tests are skipped when it is not running.
 * Run: pnpm test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

process.env.APP_URL = process.env.APP_URL || "http://127.0.0.1:3100";

const { db } = await import("@/db");
const { activityLog, calendarConnections, calendarItems, contacts, events, jobs, leads } = await import("@/db/schema");
const { encryptSecret } = await import("@/lib/crypto");
const { syncCalendarConnection } = await import("@/lib/calendar/sync");

const PORT = Number(process.env.CALDAV_TEST_PORT ?? 5232);
const USER = process.env.CALDAV_TEST_USER ?? "crm@test.local";
const PASS = process.env.CALDAV_TEST_PASS ?? "calendar-password";
const RUN = `it${Date.now().toString(36)}`;
const BASE = `http://127.0.0.1:${PORT}`;
const CAL = `${BASE}/${encodeURIComponent(USER)}/${RUN}/`;
const AUTH = { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` };

const up = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) }).then(
  () => true,
  () => false,
);

async function dav(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  return fetch(url, { method, body, headers: { ...AUTH, ...headers } });
}

/** Every object in the test calendar, as { href, etag, data }. */
async function remoteObjects(): Promise<{ href: string; etag: string; data: string }[]> {
  const res = await dav(
    "REPORT",
    CAL,
    `<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>`,
    { Depth: "1", "Content-Type": "application/xml" },
  );
  const xml = await res.text();
  return [...xml.matchAll(/<response>([\s\S]*?)<\/response>/g)].flatMap((m) => {
    const href = m[1].match(/<href>([^<]+)<\/href>/)?.[1];
    const etag = m[1].match(/<getetag>([^<]+)<\/getetag>/)?.[1]?.replace(/&quot;/g, '"');
    const data = m[1].match(/<C:calendar-data>([\s\S]*?)<\/C:calendar-data>/)?.[1]?.replace(/&#13;/g, "\r").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return href && etag && data ? [{ href: `${BASE}${href}`, etag, data }] : [];
  });
}

const findRemote = async (uidPart: string) => (await remoteObjects()).find((o) => o.data.includes(uidPart));

let connectionId: string;
let leadId: string;
/** Only what this file created is removed afterwards; other events in the database are left alone. */
const createdEventIds: string[] = [];
let contactId: string;

describe.skipIf(!up)("calendar sync with a CalDAV server", () => {
  beforeAll(async () => {
    await dav("MKCALENDAR", CAL);
    const [c] = await db
      .insert(calendarConnections)
      .values({ name: `Test ${RUN}`, serverUrl: `${BASE}/`, username: USER, passwordEncrypted: encryptSecret(PASS), calendarUrl: CAL, calendarName: RUN })
      .returning({ id: calendarConnections.id });
    connectionId = c.id;
    const [contact] = await db.insert(contacts).values({ name: `Cal Customer ${RUN}` }).returning({ id: contacts.id });
    contactId = contact.id;
    const [lead] = await db.insert(leads).values({ name: `Cal Lead ${RUN}`, status: "new" }).returning({ id: leads.id });
    leadId = lead.id;
  });

  afterAll(async () => {
    const imported = await db.query.calendarItems.findMany({ where: eq(calendarItems.connectionId, connectionId), with: { event: { columns: { id: true, fromCalendar: true } } } });
    await db.delete(calendarConnections).where(eq(calendarConnections.id, connectionId));
    const ids = [...createdEventIds, ...imported.filter((i) => i.event?.fromCalendar).map((i) => i.event!.id)];
    if (ids.length) await db.delete(events).where(inArray(events.id, ids));
    await db.delete(jobs).where(eq(jobs.contactId, contactId));
    await db.delete(leads).where(eq(leads.id, leadId));
    await db.delete(contacts).where(eq(contacts.id, contactId));
    await dav("DELETE", CAL);
  });

  it("copies a CRM site visit to the calendar with a stable UID and a link back, once", async () => {
    const [ev] = await db
      .insert(events)
      .values({ title: "Site visit: Cal Lead", location: "12 Test St", startsAt: new Date("2026-10-06T21:00:00Z"), endsAt: new Date("2026-10-06T22:00:00Z"), kind: "site_visit", leadId })
      .returning();
    createdEventIds.push(ev.id);
    const s = await syncCalendarConnection(connectionId);
    expect(s.errors).toEqual([]);
    // At least ours: a first sync also copies any other upcoming events already in the CRM.
    expect(s.pushed.created).toBeGreaterThanOrEqual(1);

    const obj = await findRemote(`crm-${ev.id}@getsecure-crm`);
    expect(obj).toBeTruthy();
    expect(obj!.data).toContain("SUMMARY:Site visit: Cal Lead");
    expect(obj!.data).toContain("DTSTART:20261006T210000Z");
    expect(obj!.data.replace(/\r\n /g, "")).toContain(`/leads/${leadId}`);

    // Syncing again changes nothing and creates no copy.
    const again = await syncCalendarConnection(connectionId, { force: true });
    expect(again.pushed).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(again.pulled).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect((await remoteObjects()).filter((o) => o.data.includes(ev.id))).toHaveLength(1);
  });

  it("sends a CRM change to the same calendar event", async () => {
    const ev = (await db.query.events.findFirst({ where: eq(events.leadId, leadId) }))!;
    await db.update(events).set({ title: "Site visit: moved", startsAt: new Date("2026-10-07T21:00:00Z"), endsAt: new Date("2026-10-07T22:30:00Z"), updatedAt: new Date() }).where(eq(events.id, ev.id));
    const s = await syncCalendarConnection(connectionId);
    expect(s.pushed.updated).toBe(1);
    const all = (await remoteObjects()).filter((o) => o.data.includes(ev.id));
    expect(all).toHaveLength(1);
    expect(all[0].data).toContain("SUMMARY:Site visit: moved");
    expect(all[0].data).toContain("DTSTART:20261007T210000Z");
  });

  it("applies a change made in the calendar to the CRM event, and notes it on the lead", async () => {
    const ev = (await db.query.events.findFirst({ where: eq(events.leadId, leadId) }))!;
    const obj = (await findRemote(ev.id))!;
    const moved = obj.data.replace("DTSTART:20261007T210000Z", "DTSTART:20261008T200000Z").replace("DTEND:20261007T223000Z", "DTEND:20261008T210000Z");
    const put = await dav("PUT", obj.href, moved, { "Content-Type": "text/calendar", "If-Match": obj.etag });
    expect(put.ok).toBe(true);

    const s = await syncCalendarConnection(connectionId);
    expect(s.pulled.updated).toBe(1);
    const after = (await db.query.events.findFirst({ where: eq(events.id, ev.id) }))!;
    expect(after.startsAt.toISOString()).toBe("2026-10-08T20:00:00.000Z");
    expect(after.endsAt.toISOString()).toBe("2026-10-08T21:00:00.000Z");
    // The CRM's own description is not polluted by the calendar's link text.
    expect(after.description ?? "").not.toContain("Open in Get Secure CRM");
    // Nor by the context line the CRM writes for the calendar ("Site visit for …").
    expect(after.description).toBeNull();
    const log = await db.query.activityLog.findFirst({ where: eq(activityLog.entityId, leadId), orderBy: (a, { desc }) => [desc(a.createdAt)] });
    expect(log?.action).toBe("site_visit_moved");

    // And the pull did not bounce straight back out as a push.
    const next = await syncCalendarConnection(connectionId);
    expect(next.pushed.updated).toBe(0);
  });

  it("imports an event made in the calendar, reading its time zone correctly", async () => {
    const uid = `titan-${RUN}-1`;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Titan//Calendar//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260920T000000Z",
      // 9am Auckland on 12 Oct is 8pm UTC the day before (NZDT, +13).
      "DTSTART;TZID=Pacific/Auckland:20261012T090000",
      "DTEND;TZID=Pacific/Auckland:20261012T100000",
      "SUMMARY:Supplier meeting",
      "LOCATION:Penrose",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      "DESCRIPTION:Reminder",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    expect((await dav("PUT", `${CAL}${uid}.ics`, ics, { "Content-Type": "text/calendar" })).ok).toBe(true);

    const s = await syncCalendarConnection(connectionId);
    expect(s.pulled.created).toBe(1);
    const item = (await db.query.calendarItems.findFirst({ where: eq(calendarItems.uid, uid) }))!;
    const ev = (await db.query.events.findFirst({ where: eq(events.id, item.eventId!) }))!;
    expect(ev.title).toBe("Supplier meeting");
    expect(ev.location).toBe("Penrose");
    expect(ev.fromCalendar).toBe(true);
    expect(ev.startsAt.toISOString()).toBe("2026-10-11T20:00:00.000Z");

    // Edited in the CRM: the calendar copy is updated in place and keeps its reminder.
    await db.update(events).set({ startsAt: new Date("2026-10-11T21:00:00Z"), endsAt: new Date("2026-10-11T22:00:00Z"), updatedAt: new Date() }).where(eq(events.id, ev.id));
    const p = await syncCalendarConnection(connectionId);
    expect(p.pushed.updated).toBe(1);
    const remote = (await findRemote(uid))!;
    expect(remote.data).toContain("DTSTART:20261011T210000Z");
    expect(remote.data).toContain("BEGIN:VALARM");
    expect((await remoteObjects()).filter((o) => o.data.includes(uid))).toHaveLength(1);
  });

  it("removes a CRM event that was deleted in the calendar, and deletes from the calendar what the CRM deleted", async () => {
    const uid = `titan-${RUN}-1`;
    const item = (await db.query.calendarItems.findFirst({ where: eq(calendarItems.uid, uid) }))!;
    const remote = (await findRemote(uid))!;
    await dav("DELETE", remote.href);
    const s = await syncCalendarConnection(connectionId);
    expect(s.pulled.deleted).toBe(1);
    expect(await db.query.events.findFirst({ where: eq(events.id, item.eventId!) })).toBeUndefined();

    const visit = (await db.query.events.findFirst({ where: eq(events.leadId, leadId) }))!;
    await db.delete(events).where(eq(events.id, visit.id));
    const d = await syncCalendarConnection(connectionId);
    expect(d.pushed.deleted).toBe(1);
    expect(await findRemote(visit.id)).toBeUndefined();
  });

  it("shows each occurrence of a repeating calendar event, read-only", async () => {
    const uid = `titan-${RUN}-weekly`;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Titan//Calendar//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260920T000000Z",
      "DTSTART:20261013T200000Z",
      "DTEND:20261013T203000Z",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "SUMMARY:Team stand-up",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    await dav("PUT", `${CAL}${uid}.ics`, ics, { "Content-Type": "text/calendar" });
    const s = await syncCalendarConnection(connectionId);
    expect(s.pulled.created).toBe(3);
    const items = await db.query.calendarItems.findMany({ where: eq(calendarItems.uid, uid) });
    const evs = await db.query.events.findMany({ where: inArray(events.id, items.map((i) => i.eventId!)) });
    expect(evs.map((e) => e.startsAt.toISOString()).sort()).toEqual(["2026-10-13T20:00:00.000Z", "2026-10-20T20:00:00.000Z", "2026-10-27T20:00:00.000Z"]);
    expect(evs.every((e) => e.readOnly)).toBe(true);

    // Read-only occurrences are never written back.
    const again = await syncCalendarConnection(connectionId, { force: true });
    expect(again.pushed.updated + again.pushed.created).toBe(0);
    expect(again.pulled.created).toBe(0);
  });

  it("copies a scheduled job, and unscheduling it removes it from the calendar", async () => {
    const [job] = await db.insert(jobs).values({ number: 900000 + Math.floor(Math.random() * 99999), title: "Install cameras", contactId }).returning();
    const [ev] = await db
      .insert(events)
      .values({ title: `#${job.number} Install cameras`, startsAt: new Date("2026-10-15T20:00:00Z"), endsAt: new Date("2026-10-16T01:00:00Z"), kind: "job", jobId: job.id })
      .returning();
    createdEventIds.push(ev.id);
    await syncCalendarConnection(connectionId);
    const remote = (await findRemote(ev.id))!;
    expect(remote.data.replace(/\r\n /g, "")).toContain(`/jobs/${job.id}`);

    await db.delete(events).where(eq(events.jobId, job.id));
    await syncCalendarConnection(connectionId);
    expect(await findRemote(ev.id)).toBeUndefined();
  });

  it("when both sides change, the later edit wins", async () => {
    const [ev] = await db
      .insert(events)
      .values({ title: "Quote review", startsAt: new Date("2026-10-20T01:00:00Z"), endsAt: new Date("2026-10-20T02:00:00Z"), kind: "other", contactId })
      .returning();
    createdEventIds.push(ev.id);
    await syncCalendarConnection(connectionId);
    const remote = (await findRemote(ev.id))!;
    // Calendar edit first (an older LAST-MODIFIED)…
    const edited = remote.data.replace("SUMMARY:Quote review", "SUMMARY:Quote review (calendar)").replace(/LAST-MODIFIED:\d{8}T\d{6}Z/, "LAST-MODIFIED:20200101T000000Z");
    await dav("PUT", remote.href, edited, { "Content-Type": "text/calendar", "If-Match": remote.etag });
    // …then a later CRM edit.
    await db.update(events).set({ title: "Quote review (CRM)", updatedAt: new Date() }).where(eq(events.id, ev.id));
    const s = await syncCalendarConnection(connectionId);
    expect(s.conflicts).toBeGreaterThanOrEqual(1);
    expect((await db.query.events.findFirst({ where: eq(events.id, ev.id) }))!.title).toBe("Quote review (CRM)");
    expect((await findRemote(ev.id))!.data).toContain("SUMMARY:Quote review (CRM)");
  });
});
