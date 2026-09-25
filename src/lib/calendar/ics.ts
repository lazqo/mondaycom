/**
 * iCalendar (RFC 5545) for the calendar sync: build the VEVENT the CRM puts in the calendar, and
 * read the events the calendar holds.
 *
 * Times are written in UTC, which every CalDAV server and client understands. Times read back may
 * be UTC, in a named zone (with or without the VTIMEZONE block that should come with it), or
 * floating; all are converted to real instants here. Repeating events are expanded into their
 * occurrences inside the sync window.
 */
import ICAL from "ical.js";

/** Put on every CRM event, so its link back to the CRM survives any edit made in the calendar. */
export const CRM_EVENT_PROPERTY = "x-getsecure-crm-event";

/** The line the CRM adds before its own text in a description. Everything from it on is stripped on read. */
const CRM_SEPARATOR = "— Get Secure CRM —";
const LINK_LABEL = "Open in Get Secure CRM:";

export function crmEventUid(eventId: string): string {
  return `crm-${eventId}@getsecure-crm`;
}

/** The CRM event id inside a UID we issued, or null for an event made in the calendar. */
export function crmEventIdFromUid(uid: string): string | null {
  return uid.match(/^crm-([0-9a-f-]{36})@getsecure-crm$/)?.[1] ?? null;
}

// ---------- time zones ----------

function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-NZ", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds a zone is ahead of UTC at a given instant. */
function zoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A wall-clock time in a zone ("9:00 on 28 Sept in Auckland") as the instant it names. */
export function zonedToUtc(p: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }, tz: string): Date {
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  // Two passes settle the offset either side of a daylight-saving change.
  let guess = wall - zoneOffsetMs(new Date(wall), tz);
  guess = wall - zoneOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

/** The calendar date of an instant in a zone, as numbers. */
export function datePartsIn(at: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: n("year"), month: n("month"), day: n("day") };
}

/** The TZID a parsed time carried. ical.js keeps it at runtime but leaves it out of its types. */
function tzidOf(t: ICAL.Time): string | null {
  return (t as unknown as { timezone?: string }).timezone ?? null;
}

function timeToDate(t: ICAL.Time, fallbackTzid: string | null, appTz: string): Date {
  if (t.zone?.tzid === "UTC") return t.toJSDate();
  const tzid = tzidOf(t) ?? fallbackTzid;
  if (tzid && isIanaZone(tzid)) return zonedToUtc(t, tzid);
  // A zone only the calendar's own VTIMEZONE block describes (Outlook's "New Zealand Standard Time").
  const registered = tzid ? ICAL.TimezoneService.get(tzid) : null;
  if (registered) {
    const c = t.clone();
    c.zone = registered;
    return new Date(c.toUnixTime() * 1000);
  }
  // Floating time: it means local time wherever you are, which for this business is the app's zone.
  return zonedToUtc(t, appTz);
}

// ---------- reading ----------

export type CalendarInstance = {
  uid: string;
  /** "" for a single event, else the occurrence's original start, which never changes. */
  recurrenceId: string;
  recurring: boolean;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  lastModified: Date | null;
  /** Present when the event was made by the CRM. */
  crmEventId: string | null;
  cancelled: boolean;
};

/** Remove the link line the CRM appended, so a round trip does not keep adding it. */
export function stripCrmFooter(description: string | null | undefined): string | null {
  if (!description) return null;
  const at = [description.indexOf(CRM_SEPARATOR), description.indexOf(LINK_LABEL)].filter((n) => n >= 0);
  const i = at.length ? Math.min(...at) : -1;
  const text = (i >= 0 ? description.slice(0, i) : description).trim();
  return text || null;
}

function text(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * Every event in one calendar object, repeating ones expanded to their occurrences that overlap
 * [from, to]. At most `maxOccurrences` per repeating event, so an endless rule cannot run away.
 */
export function readCalendarObject(ics: string, window: { from: Date; to: Date }, appTz: string, maxOccurrences = 200): CalendarInstance[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    const tzid = String(tz.getFirstPropertyValue("tzid") ?? "");
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  }

  const vevents = root.getAllSubcomponents("vevent");
  const masters = vevents.filter((v) => !v.hasProperty("recurrence-id"));
  const exceptions = vevents.filter((v) => v.hasProperty("recurrence-id"));
  const out: CalendarInstance[] = [];

  const build = (
    v: ICAL.Component,
    e: ICAL.Event,
    start: ICAL.Time,
    end: ICAL.Time,
    recurrenceId: string,
    recurring: boolean,
    tzid: string | null,
  ): CalendarInstance => {
    const allDay = start.isDate;
    let startsAt: Date;
    let endsAt: Date;
    if (allDay) {
      // All-day: midnight of the first day to 23:59 of the last, the way the CRM stores all-day events.
      startsAt = zonedToUtc({ year: start.year, month: start.month, day: start.day }, appTz);
      const lastDay = end.clone();
      if (end.compare(start) > 0) lastDay.adjust(-1, 0, 0, 0);
      endsAt = zonedToUtc({ year: lastDay.year, month: lastDay.month, day: lastDay.day, hour: 23, minute: 59 }, appTz);
    } else {
      startsAt = timeToDate(start, tzid, appTz);
      endsAt = timeToDate(end, tzid, appTz);
      if (endsAt <= startsAt) endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    }
    const lm = v.getFirstPropertyValue("last-modified") ?? v.getFirstPropertyValue("dtstamp");
    return {
      uid: e.uid,
      recurrenceId,
      recurring,
      title: text(e.summary) ?? "(no title)",
      description: stripCrmFooter(text(e.description)),
      location: text(e.location),
      startsAt,
      endsAt,
      allDay,
      lastModified: lm instanceof ICAL.Time ? lm.toJSDate() : null,
      crmEventId: text(v.getFirstPropertyValue(CRM_EVENT_PROPERTY)) ?? crmEventIdFromUid(e.uid),
      cancelled: String(v.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED",
    };
  };

  for (const v of masters) {
    const event = new ICAL.Event(v, { exceptions: exceptions.filter((x) => x.getFirstPropertyValue("uid") === v.getFirstPropertyValue("uid")) });
    const tzid = tzidOf(event.startDate);
    if (!event.isRecurring()) {
      const end = event.endDate ?? event.startDate;
      out.push(build(v, event, event.startDate, end, "", false, tzid));
      continue;
    }
    const it = event.iterator();
    let n = 0;
    for (let t = it.next(); t && n < maxOccurrences; t = it.next()) {
      const d = event.getOccurrenceDetails(t);
      const itemTz = tzidOf(d.item.startDate) ?? tzid;
      const startsAt = d.startDate.isDate ? zonedToUtc(d.startDate, appTz) : timeToDate(d.startDate, itemTz, appTz);
      if (startsAt > window.to) break;
      const endsAt = d.endDate.isDate ? zonedToUtc(d.endDate, appTz) : timeToDate(d.endDate, itemTz, appTz);
      if (endsAt < window.from) continue;
      n++;
      out.push(build(d.item.component, d.item, d.startDate, d.endDate, d.recurrenceId.toString(), true, itemTz));
    }
  }
  return out;
}

// ---------- writing ----------

export type CrmEventForCalendar = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  updatedAt: Date;
  kindLabel: string;
  /** Where the event leads in the CRM, as a full URL. */
  link: string | null;
  /** "Site visit for Dave Lincoln", "Job J-12 for Kiri Brown"… */
  context: string | null;
};

function utc(d: Date): ICAL.Time {
  return ICAL.Time.fromJSDate(d, true);
}

function dateOnly(d: Date, tz: string, addDays = 0): ICAL.Time {
  const p = datePartsIn(d, tz);
  const t = ICAL.Time.fromData({ year: p.year, month: p.month, day: p.day, isDate: true });
  if (addDays) t.adjust(addDays, 0, 0, 0);
  return t;
}

function setProp(v: ICAL.Component, name: string, value: string | ICAL.Time | null) {
  v.removeAllProperties(name);
  if (value === null || value === "") return;
  v.addPropertyWithValue(name, value);
}

/**
 * The calendar object for a CRM event. With `existing` (the calendar's current copy) only the
 * fields the CRM owns are replaced, so alarms, attendees and colours set in the calendar survive.
 */
export function writeCrmEvent(ev: CrmEventForCalendar, opts: { uid: string; appTz: string; existing?: string | null }): string {
  let root: ICAL.Component;
  let v: ICAL.Component | null = null;
  if (opts.existing) {
    try {
      root = new ICAL.Component(ICAL.parse(opts.existing));
      v = root.getAllSubcomponents("vevent").find((c) => !c.hasProperty("recurrence-id")) ?? null;
    } catch {
      root = new ICAL.Component(["vcalendar", [], []]);
    }
  } else {
    root = new ICAL.Component(["vcalendar", [], []]);
  }
  if (!root.hasProperty("version")) root.addPropertyWithValue("version", "2.0");
  if (!root.hasProperty("prodid")) root.addPropertyWithValue("prodid", "-//Get Secure//CRM//EN");
  if (!v) {
    v = new ICAL.Component("vevent");
    root.addSubcomponent(v);
  }

  setProp(v, "uid", opts.uid);
  setProp(v, "dtstamp", utc(new Date()));
  setProp(v, "last-modified", utc(ev.updatedAt));
  // DTSTART/DTEND carry a TZID or VALUE=DATE parameter, so they are rebuilt rather than edited.
  v.removeAllProperties("dtstart");
  v.removeAllProperties("dtend");
  v.removeAllProperties("duration");
  if (ev.allDay) {
    v.addPropertyWithValue("dtstart", dateOnly(ev.startsAt, opts.appTz));
    v.addPropertyWithValue("dtend", dateOnly(ev.endsAt, opts.appTz, 1));
  } else {
    v.addPropertyWithValue("dtstart", utc(ev.startsAt));
    v.addPropertyWithValue("dtend", utc(ev.endsAt));
  }
  setProp(v, "summary", ev.title);
  setProp(v, "location", ev.location);
  // The CRM's own lines go after a separator, so reading the event back can tell them apart from
  // what was typed as the event's notes.
  const ours = [ev.context, ev.link ? `${LINK_LABEL} ${ev.link}` : null].filter(Boolean).join("\n");
  const description = [ev.description?.trim() || null, ours ? `${CRM_SEPARATOR}\n${ours}` : null].filter(Boolean).join("\n\n");
  setProp(v, "description", description || null);
  setProp(v, "url", ev.link);
  setProp(v, "categories", ev.kindLabel);
  setProp(v, CRM_EVENT_PROPERTY, ev.id);
  return root.toString();
}

/** Replace the time and text of an event made in the calendar, keeping everything else it has. */
export function patchCalendarEvent(
  existing: string,
  change: { title: string; description: string | null; location: string | null; startsAt: Date; endsAt: Date; allDay: boolean; updatedAt: Date },
  appTz: string,
): string {
  const root = new ICAL.Component(ICAL.parse(existing));
  const v = root.getAllSubcomponents("vevent").find((c) => !c.hasProperty("recurrence-id"));
  if (!v) return existing;
  setProp(v, "dtstamp", utc(new Date()));
  setProp(v, "last-modified", utc(change.updatedAt));
  v.removeAllProperties("dtstart");
  v.removeAllProperties("dtend");
  v.removeAllProperties("duration");
  if (change.allDay) {
    v.addPropertyWithValue("dtstart", dateOnly(change.startsAt, appTz));
    v.addPropertyWithValue("dtend", dateOnly(change.endsAt, appTz, 1));
  } else {
    v.addPropertyWithValue("dtstart", utc(change.startsAt));
    v.addPropertyWithValue("dtend", utc(change.endsAt));
  }
  setProp(v, "summary", change.title);
  setProp(v, "location", change.location);
  setProp(v, "description", change.description);
  return root.toString();
}
