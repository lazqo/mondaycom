import { describe, it, expect } from "vitest";
import { crmEventIdFromUid, crmEventUid, patchCalendarEvent, readCalendarObject, stripCrmFooter, writeCrmEvent, zonedToUtc } from "@/lib/calendar/ics";

const TZ = "Pacific/Auckland";
const WINDOW = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2027-12-31T00:00:00Z") };
const ID = "3f0c7a52-3d5e-4a0b-9d8e-1c2b3a4d5e6f";

function wrap(...lines: string[]) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
}

describe("time zones", () => {
  it("converts Auckland wall-clock time either side of daylight saving", () => {
    // NZST (+12) in winter, NZDT (+13) in summer.
    expect(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, TZ).toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(zonedToUtc({ year: 2026, month: 12, day: 1, hour: 9 }, TZ).toISOString()).toBe("2026-11-30T20:00:00.000Z");
  });
});

describe("reading calendar events", () => {
  it("reads UTC, named-zone and floating times as the right instant", () => {
    const events = readCalendarObject(
      wrap(
        "BEGIN:VEVENT", "UID:a", "DTSTAMP:20260101T000000Z", "DTSTART:20261012T200000Z", "DTEND:20261012T210000Z", "SUMMARY:UTC", "END:VEVENT",
        "BEGIN:VEVENT", "UID:b", "DTSTAMP:20260101T000000Z", "DTSTART;TZID=Pacific/Auckland:20261013T090000", "DTEND;TZID=Pacific/Auckland:20261013T100000", "SUMMARY:Zoned", "END:VEVENT",
        "BEGIN:VEVENT", "UID:c", "DTSTAMP:20260101T000000Z", "DTSTART:20261014T090000", "DTEND:20261014T100000", "SUMMARY:Floating", "END:VEVENT",
      ),
      WINDOW,
      TZ,
    );
    const at = Object.fromEntries(events.map((e) => [e.uid, e.startsAt.toISOString()]));
    expect(at.a).toBe("2026-10-12T20:00:00.000Z");
    expect(at.b).toBe("2026-10-12T20:00:00.000Z");
    expect(at.c).toBe("2026-10-13T20:00:00.000Z");
  });

  it("uses the calendar's own VTIMEZONE for zone names that are not IANA ones", () => {
    const [e] = readCalendarObject(
      wrap(
        "BEGIN:VTIMEZONE", "TZID:New Zealand Standard Time",
        "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+1300", "TZOFFSETTO:+1200", "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4", "END:STANDARD",
        "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:+1200", "TZOFFSETTO:+1300", "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=9", "END:DAYLIGHT",
        "END:VTIMEZONE",
        "BEGIN:VEVENT", "UID:outlook", "DTSTAMP:20260101T000000Z", "DTSTART;TZID=New Zealand Standard Time:20260701T090000", "DTEND;TZID=New Zealand Standard Time:20260701T100000", "SUMMARY:Outlook", "END:VEVENT",
      ),
      WINDOW,
      TZ,
    );
    expect(e.startsAt.toISOString()).toBe("2026-06-30T21:00:00.000Z");
  });

  it("reads an all-day event as that whole day in the business's zone", () => {
    const [e] = readCalendarObject(wrap("BEGIN:VEVENT", "UID:d", "DTSTAMP:20260101T000000Z", "DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261002", "SUMMARY:All day", "END:VEVENT"), WINDOW, TZ);
    expect(e.allDay).toBe(true);
    expect(e.startsAt.toISOString()).toBe("2026-09-30T11:00:00.000Z");
    expect(e.endsAt.toISOString()).toBe("2026-10-01T10:59:00.000Z");
  });

  it("expands a repeating event, applying a moved occurrence", () => {
    const events = readCalendarObject(
      wrap(
        "BEGIN:VEVENT", "UID:w", "DTSTAMP:20260101T000000Z", "DTSTART;TZID=Pacific/Auckland:20261005T090000", "DTEND;TZID=Pacific/Auckland:20261005T093000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Weekly", "END:VEVENT",
        "BEGIN:VEVENT", "UID:w", "DTSTAMP:20260101T000000Z", "RECURRENCE-ID;TZID=Pacific/Auckland:20261012T090000", "DTSTART;TZID=Pacific/Auckland:20261012T110000", "DTEND;TZID=Pacific/Auckland:20261012T113000", "SUMMARY:Weekly (moved)", "END:VEVENT",
      ),
      WINDOW,
      TZ,
    );
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.recurring && e.recurrenceId)).toBe(true);
    const moved = events.find((e) => e.title === "Weekly (moved)")!;
    expect(moved.startsAt.toISOString()).toBe("2026-10-11T22:00:00.000Z");
    expect(new Set(events.map((e) => e.recurrenceId)).size).toBe(3);
  });

  it("skips nothing and invents nothing for a cancelled event: it is marked cancelled", () => {
    const [e] = readCalendarObject(wrap("BEGIN:VEVENT", "UID:x", "DTSTAMP:20260101T000000Z", "STATUS:CANCELLED", "DTSTART:20261012T200000Z", "DTEND:20261012T210000Z", "SUMMARY:Off", "END:VEVENT"), WINDOW, TZ);
    expect(e.cancelled).toBe(true);
  });
});

describe("writing CRM events", () => {
  const ev = {
    id: ID,
    title: "Site visit: Dave Lincoln",
    description: "Bring the ladder",
    location: "5 Ponsonby Rd",
    startsAt: new Date("2026-10-06T21:00:00Z"),
    endsAt: new Date("2026-10-06T22:00:00Z"),
    allDay: false,
    updatedAt: new Date("2026-09-25T00:00:00Z"),
    kindLabel: "Site visit",
    link: "https://crm.example/leads/abc",
    context: "Site visit for Dave Lincoln",
  };

  it("uses a stable UID that points back at the CRM event", () => {
    expect(crmEventIdFromUid(crmEventUid(ID))).toBe(ID);
    expect(crmEventIdFromUid("someone-else@titan")).toBeNull();
  });

  it("round-trips: what the CRM writes reads back as the same event, without the CRM's own lines", () => {
    const ics = writeCrmEvent(ev, { uid: crmEventUid(ID), appTz: TZ });
    expect(ics).toContain(`UID:${crmEventUid(ID)}`);
    expect(ics).toContain("DTSTART:20261006T210000Z");
    const [back] = readCalendarObject(ics, WINDOW, TZ);
    expect(back.title).toBe(ev.title);
    expect(back.location).toBe(ev.location);
    expect(back.startsAt.toISOString()).toBe(ev.startsAt.toISOString());
    expect(back.description).toBe("Bring the ladder");
    expect(back.crmEventId).toBe(ID);
  });

  it("writes an all-day event as dates", () => {
    const ics = writeCrmEvent({ ...ev, allDay: true, startsAt: new Date("2026-10-06T11:00:00Z"), endsAt: new Date("2026-10-07T10:59:00Z") }, { uid: crmEventUid(ID), appTz: TZ });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261007");
    expect(ics).toContain("DTEND;VALUE=DATE:20261008");
  });

  it("keeps the calendar's alarms when updating an existing copy", () => {
    const first = writeCrmEvent(ev, { uid: crmEventUid(ID), appTz: TZ });
    const withAlarm = first.replace("END:VEVENT", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT30M\r\nDESCRIPTION:Soon\r\nEND:VALARM\r\nEND:VEVENT");
    const next = writeCrmEvent({ ...ev, title: "Moved visit", startsAt: new Date("2026-10-07T21:00:00Z"), endsAt: new Date("2026-10-07T22:00:00Z") }, { uid: crmEventUid(ID), appTz: TZ, existing: withAlarm });
    expect(next).toContain("BEGIN:VALARM");
    expect(next).toContain("SUMMARY:Moved visit");
    expect(next.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("patches an event made in the calendar without losing its other properties", () => {
    const original = wrap("BEGIN:VEVENT", "UID:t1", "DTSTAMP:20260101T000000Z", "DTSTART;TZID=Pacific/Auckland:20261013T090000", "DTEND;TZID=Pacific/Auckland:20261013T100000", "SUMMARY:Supplier", "ATTENDEE:mailto:rep@supplier.test", "END:VEVENT");
    const patched = patchCalendarEvent(original, { title: "Supplier (moved)", description: null, location: "Penrose", startsAt: new Date("2026-10-13T21:00:00Z"), endsAt: new Date("2026-10-13T22:00:00Z"), allDay: false, updatedAt: new Date() }, TZ);
    expect(patched).toContain("ATTENDEE:mailto:rep@supplier.test");
    expect(patched).toContain("DTSTART:20261013T210000Z");
    expect(patched).not.toContain("TZID=Pacific/Auckland:20261013T090000");
  });

  it("strips only the CRM's lines from a description", () => {
    expect(stripCrmFooter("Gate code 1234\n\n— Get Secure CRM —\nSite visit for X\nOpen in Get Secure CRM: https://x")).toBe("Gate code 1234");
    expect(stripCrmFooter("— Get Secure CRM —\nSite visit for X")).toBeNull();
    expect(stripCrmFooter("Just notes")).toBe("Just notes");
  });
});
