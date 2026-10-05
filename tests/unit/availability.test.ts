/**
 * When Get Secure can come: free slots inside business hours on working days, clear of what is
 * booked, honouring the customer's timing words. Pure: no database.
 */
import { describe, it, expect } from "vitest";
import { clashWith, freeSlots, slotLabel, timingWindow } from "@/lib/calendar/availability";
import { clockTime, resolveAt } from "@/lib/inspector/dates";

const AT = new Date("2026-10-07T01:00:00Z"); // 2pm Wednesday 7 Oct 2026, Auckland (NZDT, UTC+13)
const hours = { start: 8, end: 17 };
const nz = (iso: string) => new Date(iso);
/** "Thu 08": weekday and hour (24h) in Auckland. */
const local = (d: Date) => new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", weekday: "short", hour: "numeric", hour12: false }).format(d).replace(",", "");

describe("free slots", () => {
  it("never today, Monday to Friday, inside business hours, one a day, mornings and afternoons alternating", () => {
    const s = freeSlots({ from: AT, durationMin: 60, busy: [], hours });
    expect(s).toHaveLength(3);
    expect(s.map((x) => local(x.startsAt))).toEqual(["Thu 08", "Fri 12", "Mon 08"]); // Thursday morning, Friday afternoon, Monday morning: the weekend is skipped
    for (const x of s) expect(x.endsAt.getTime() - x.startsAt.getTime()).toBe(3600000);
  });

  it("keeps clear of what is booked, with a travel buffer either side", () => {
    // Thursday 8am–10am is taken: 8 and 9 clash, 10 clashes with the buffer, 11 is free.
    const busy = [{ startsAt: nz("2026-10-07T19:00:00Z"), endsAt: nz("2026-10-07T21:00:00Z") }];
    const s = freeSlots({ from: AT, durationMin: 60, busy, hours, max: 1 });
    expect(local(s[0].startsAt)).toBe("Thu 11");
  });

  it("honours the customer's timing: a day, a part of the day, next week", () => {
    const thursdayMorning = freeSlots({ from: AT, durationMin: 60, busy: [], hours, window: timingWindow("thursday morning", AT) });
    expect(thursdayMorning.map((x) => local(x.startsAt))).toEqual(["Thu 08"]);
    const afternoons = freeSlots({ from: AT, durationMin: 60, busy: [], hours, window: timingWindow("afternoons", AT) });
    expect(afternoons.every((x) => Number(local(x.startsAt).split(" ")[1]) >= 12)).toBe(true);
    const nextWeek = freeSlots({ from: AT, durationMin: 60, busy: [], hours, window: timingWindow("next week", AT) });
    expect(nextWeek.map((x) => local(x.startsAt).split(" ")[0])).toEqual(["Mon", "Tue", "Wed"]);
    expect(nextWeek[0].startsAt.toISOString()).toBe("2026-10-11T19:00:00.000Z"); // Monday 12 Oct, 8am NZDT
  });

  it("a longer job takes a slot that fits before close; words it cannot place give an open window", () => {
    const s = freeSlots({ from: AT, durationMin: 180, busy: [], hours, max: 1 });
    expect(local(s[0].startsAt)).toBe("Thu 08");
    expect(timingWindow("whenever suits", AT)).toEqual({ from: null, to: null, part: null });
    expect(timingWindow(null, AT)).toEqual({ from: null, to: null, part: null });
  });

  it("a stated time is read as a clock time on the day the words give", () => {
    expect(clockTime("today at 3 p.m.")).toEqual({ hour: 15, minute: 0 });
    expect(clockTime("3:30pm")).toEqual({ hour: 15, minute: 30 });
    expect(clockTime("15:00")).toEqual({ hour: 15, minute: 0 });
    expect(clockTime("10 am")).toEqual({ hour: 10, minute: 0 });
    expect(clockTime("midday")).toEqual({ hour: 12, minute: 0 });
    expect(clockTime("next week")).toBeNull();
    expect(resolveAt("today at 3 p.m.", AT)!.toISOString()).toBe("2026-10-07T02:00:00.000Z"); // 3pm Wed 7 Oct NZDT
    expect(resolveAt("thursday 10am", AT)!.toISOString()).toBe("2026-10-07T21:00:00.000Z"); // 10am Thu 8 Oct
    expect(resolveAt("8 October 3pm", AT)!.toISOString()).toBe("2026-10-08T02:00:00.000Z");
    expect(resolveAt("next week", AT)).toBeNull(); // a window, not an appointment
  });

  it("names what a slot would clash with, buffer included", () => {
    const busy = [{ startsAt: nz("2026-10-07T02:00:00Z"), endsAt: nz("2026-10-07T03:00:00Z"), title: "Site visit — Tim" }];
    expect(clashWith({ startsAt: nz("2026-10-07T02:30:00Z"), endsAt: nz("2026-10-07T03:30:00Z") }, busy)).toMatch(/Site visit — Tim/);
    expect(clashWith({ startsAt: nz("2026-10-07T03:15:00Z"), endsAt: nz("2026-10-07T04:15:00Z") }, busy)).toMatch(/Site visit — Tim/); // inside the travel buffer
    expect(clashWith({ startsAt: nz("2026-10-07T04:00:00Z"), endsAt: nz("2026-10-07T05:00:00Z") }, busy)).toBeNull();
  });

  it("labels a slot the way Chris would say it", () => {
    expect(slotLabel({ startsAt: nz("2026-10-07T21:00:00Z"), endsAt: nz("2026-10-07T22:00:00Z") })).toBe("Thu, 8 Oct, 10:00 am – 11:00 am");
  });
});
