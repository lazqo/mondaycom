/**
 * When Get Secure can come: free slots inside business hours on working days, around what is
 * already in the calendar, honouring what the customer said about timing ("next week", "Thursday
 * morning"). The pure part (freeSlots, timingWindow) is tested on its own; suggestSlots reads the
 * calendar and the settings. Nothing here books anything: a slot becomes an event only when Chris
 * accepts it (src/lib/calendar/book.ts).
 */
import { and, gte, isNull, lte, or, eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { datePartsIn, zonedToUtc } from "@/lib/calendar/ics";
import { resolveAt, resolveDue, TZ } from "@/lib/inspector/dates";
import { cctvAssessments } from "@/db/schema";
import { desc } from "drizzle-orm";
import { assignee } from "@/lib/inspector/work";
import { getAutomationSettings } from "@/lib/settings";

export type Busy = { startsAt: Date; endsAt: Date };
export type Slot = { startsAt: Date; endsAt: Date };
export type TimingWindow = { from: Date | null; to: Date | null; part: "morning" | "afternoon" | null };

/** Travel and set-up either side of an appointment. */
export const TRAVEL_BUFFER_MIN = 30;
/** How far ahead to look for a free slot, in working days. */
const LOOKAHEAD_DAYS = 10;

const dayStart = (d: Date, tz: string) => zonedToUtc({ ...datePartsIn(d, tz), hour: 0, minute: 0 }, tz);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const weekday = (parts: { year: number; month: number; day: number }) => new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();

/**
 * What the customer's timing words mean as a window: a day ("Thursday", "tomorrow", "the 14th of
 * October"), a week ("next week", "this week"), soon ("asap", "in a couple of days"), and/or a part
 * of the day. Unknown words give an open window.
 */
export function timingWindow(timing: string | null | undefined, when: Date, tz = TZ): TimingWindow {
  const p = (timing ?? "").toLowerCase().trim();
  const part: TimingWindow["part"] = /morning/.test(p) ? "morning" : /afternoon|arvo/.test(p) ? "afternoon" : null;
  if (!p) return { from: null, to: null, part };
  const due = resolveDue(p, when);
  if (!due) return { from: null, to: null, part };
  const start = dayStart(due, tz);
  if (/next week/.test(p)) return { from: start, to: addDays(start, 7), part };
  if (/this week|end of (the |this )?week/.test(p)) return { from: null, to: addDays(start, 1), part };
  if (/^(asap|as soon|straight away|right away|shortly|in a bit|in an hour)/.test(p) || /in (a |one |two |three |\d+ )(couple of )?days?/.test(p)) return { from: null, to: addDays(start, 3), part };
  return { from: start, to: addDays(start, 1), part };
}

/**
 * Free slots: never today, Monday to Friday, inside business hours, clear of busy periods plus a
 * travel buffer, at most one per day so the offer spreads across the week (mornings and afternoons
 * alternating unless the customer asked for one).
 */
export function freeSlots(opts: { from: Date; durationMin: number; busy: Busy[]; hours: { start: number; end: number }; bufferMin?: number; window?: TimingWindow | null; max?: number; days?: number; tz?: string }): Slot[] {
  const tz = opts.tz ?? TZ;
  const buffer = (opts.bufferMin ?? TRAVEL_BUFFER_MIN) * 60000;
  const max = opts.max ?? 3;
  const w = opts.window ?? { from: null, to: null, part: null };
  const out: Slot[] = [];
  // Start the day after `from` (or the window's first day if later); look ahead a working fortnight.
  let day = addDays(dayStart(opts.from, tz), 1);
  if (w.from && w.from > day) day = dayStart(w.from, tz);
  const lastHourStart = opts.hours.end - opts.durationMin / 60;
  for (let n = 0, seen = 0; seen < (opts.days ?? LOOKAHEAD_DAYS) && out.length < max && n < 40; n++, day = addDays(day, 1)) {
    const parts = datePartsIn(day, tz);
    const dow = weekday(parts);
    if (dow === 0 || dow === 6) continue;
    seen++;
    if (w.to && day >= w.to) break;
    const prefer: TimingWindow["part"] = w.part ?? (seen % 2 === 1 ? "morning" : "afternoon");
    const hours: number[] = [];
    for (let h = opts.hours.start; h <= lastHourStart; h++) hours.push(h);
    const ordered = [...hours.filter((h) => (prefer === "morning" ? h < 12 : h >= 12)), ...(w.part ? [] : hours.filter((h) => (prefer === "morning" ? h >= 12 : h < 12)))];
    for (const h of ordered) {
      const startsAt = zonedToUtc({ ...parts, hour: h, minute: 0 }, tz);
      const endsAt = new Date(startsAt.getTime() + opts.durationMin * 60000);
      if (startsAt <= opts.from) continue;
      if (w.from && startsAt < w.from) continue;
      if (w.to && endsAt > w.to) continue;
      const clash = opts.busy.some((b) => startsAt.getTime() < b.endsAt.getTime() + buffer && endsAt.getTime() > b.startsAt.getTime() - buffer);
      if (clash) continue;
      out.push({ startsAt, endsAt });
      break;
    }
  }
  return out;
}

/** "Wed 8 Oct, 10:00 am – 11:00 am" in the app's time zone. */
export function slotLabel(slot: Slot, tz = TZ): string {
  const day = new Intl.DateTimeFormat("en-NZ", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(slot.startsAt);
  const time = (d: Date) => new Intl.DateTimeFormat("en-NZ", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\s?([ap])\.?m\.?/i, " $1m");
  return `${day}, ${time(slot.startsAt)} – ${time(slot.endsAt)}`;
}

export type SuggestedSlot = { startsAt: string; endsAt: string; label: string; /** The time the customer or Chris actually said. */ stated?: boolean; /** What it would clash with in the calendar, if anything. */ clash?: string | null };

/** What is already in the calendar that a slot would overlap (with the travel buffer). */
export function clashWith(slot: Slot, busy: (Busy & { title?: string | null })[], bufferMin = TRAVEL_BUFFER_MIN): string | null {
  const buffer = bufferMin * 60000;
  const hit = busy.filter((b) => slot.startsAt.getTime() < b.endsAt.getTime() + buffer && slot.endsAt.getTime() > b.startsAt.getTime() - buffer);
  return hit.length ? hit.map((b) => `${b.title ?? "an appointment"} (${slotLabel(b)})`).join("; ") : null;
}

/** How long to pencil the work in for: the settings, or the Business Brain's labour estimate for an install. */
export async function durationFor(kind: "site_visit" | "booking" | "service", leadId: string | null): Promise<number> {
  const settings = await getAutomationSettings();
  if (kind === "site_visit") return settings.site_visit_minutes;
  if (kind === "service") return settings.service_call_minutes;
  if (leadId) {
    const a = await db.query.cctvAssessments.findFirst({ where: eq(cctvAssessments.leadId, leadId), orderBy: [desc(cctvAssessments.createdAt)], columns: { packet: true } });
    const hours = (a?.packet as { labour?: { estimatedHours?: number | null } } | undefined)?.labour?.estimatedHours;
    if (hours && hours > 0) return Math.round(hours * 60);
  }
  return Math.round(settings.install_hours * 60);
}

/**
 * Slots for a site visit or booking. A time the customer or Chris stated comes first (as said, with
 * any clash named); free slots from the calendar follow, inside the customer's window.
 */
export async function suggestSlots(opts: { leadId: string | null; contactId?: string | null; jobId?: string | null; timing: string | null; durationMin: number; now?: Date; /** When the words were said: "today at 3" is relative to this. */ saidAt?: Date }): Promise<{ slots: SuggestedSlot[]; technicianId: string | null; durationMin: number; timing: string | null }> {
  const now = opts.now ?? new Date();
  const technicianId = await assignee(opts.leadId);
  const settings = await getAutomationSettings();
  const statedAt = opts.timing ? resolveAt(opts.timing, opts.saidAt ?? now) : null;
  // What is booked around now and, if a time was stated, around that time too (it may be far ahead).
  const from = new Date(Math.min(now.getTime(), statedAt?.getTime() ?? now.getTime()) - 86400000);
  const horizon = new Date(Math.max(addDays(now, 28).getTime(), statedAt ? addDays(statedAt, 1).getTime() : 0));
  const busy = await db
    .select({ startsAt: events.startsAt, endsAt: events.endsAt, title: events.title })
    .from(events)
    .where(and(gte(events.endsAt, from), lte(events.startsAt, horizon), technicianId ? or(eq(events.assignedToId, technicianId), isNull(events.assignedToId)) : undefined));
  const out: SuggestedSlot[] = [];
  if (statedAt) {
    const slot = { startsAt: statedAt, endsAt: new Date(statedAt.getTime() + opts.durationMin * 60000) };
    out.push({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), label: slotLabel(slot), stated: true, clash: clashWith(slot, busy) });
  }
  const free = freeSlots({ from: now, durationMin: opts.durationMin, busy, hours: { start: settings.business_hours_start, end: settings.business_hours_end }, window: statedAt ? null : timingWindow(opts.timing, now), max: statedAt ? 2 : 3 });
  for (const s of free) if (!out.some((o) => o.startsAt === s.startsAt.toISOString())) out.push({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), label: slotLabel(s), stated: false, clash: null });
  return { slots: out, technicianId, durationMin: opts.durationMin, timing: opts.timing };
}
