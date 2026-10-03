/**
 * Turning "tonight", "tomorrow morning", "by Friday" or "next week" into a due time, in New
 * Zealand time, relative to when the email or conversation happened. Pure.
 */
import { datePartsIn, zonedToUtc } from "@/lib/calendar/ics";

export const TZ = "Pacific/Auckland";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The time words the resolver understands, for finding them inside a sentence. */
export const TIME_PATTERN = new RegExp(
  [
    "tonight",
    "this (?:evening|afternoon|arvo|morning)",
    "later today",
    "today",
    "end of (?:the )?day",
    "tomorrow(?: (?:morning|afternoon|night|arvo))?",
    "(?:first thing )?(?:on |by |this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: (?:morning|afternoon|arvo))?",
    "(?:by )?(?:the )?end of (?:the |this )?week",
    "next week",
    "this week",
    "in (?:a |one |two |three |\\d+ )(?:couple of )?days?",
    "(?:by |on )?\\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:" + MONTHS.join("|") + ")",
    "asap|as soon as (?:possible|i can)|straight away|right away|shortly|in a bit|in an hour",
  ].join("|"),
  "i",
);

function at(base: { year: number; month: number; day: number }, addDays: number, hour: number): Date {
  const d = new Date(Date.UTC(base.year, base.month - 1, base.day + addDays));
  return zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute: 0 }, TZ);
}

/**
 * Resolve a time phrase said at `when`. Returns null when the words give no usable time.
 * Times: tonight 9pm, morning noon, afternoon/today/a weekday 5pm.
 */
export function resolveDue(phrase: string, when: Date): Date | null {
  const p = phrase.toLowerCase().trim();
  const today = datePartsIn(when, TZ);
  const dow = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const part = (fallback: number) => (/morning/.test(p) ? 12 : /night|evening|tonight/.test(p) ? 21 : fallback);

  if (/^(asap|as soon as (possible|i can)|straight away|right away|shortly|in a bit|in an hour)$/.test(p)) return at(today, 0, 17);
  if (/tonight|this evening/.test(p)) return at(today, 0, 21);
  if (/this morning/.test(p)) return at(today, 0, 12);
  if (/this (afternoon|arvo)|later today|today|end of (the )?day/.test(p)) return at(today, 0, 17);
  if (/tomorrow/.test(p)) return at(today, 1, part(17));
  const inDays = /in (a |one |two |three |(\d+) )(couple of )?days?/.exec(p);
  if (inDays) {
    const n = inDays[3] ? 2 : inDays[2] ? Number(inDays[2]) : { "a ": 1, "one ": 1, "two ": 2, "three ": 3 }[inDays[1]] ?? 1;
    return at(today, n, 17);
  }
  if (/end of (the |this )?week/.test(p)) return at(today, (5 - dow + 7) % 7, 17);
  if (/next week/.test(p)) return at(today, (1 - dow + 7) % 7 || 7, 17);
  if (/this week/.test(p)) return at(today, (5 - dow + 7) % 7, 17);
  const day = DAYS.findIndex((d) => p.includes(d));
  if (day >= 0) {
    let add = (day - dow + 7) % 7;
    if (/next /.test(p) && add === 0) add = 7;
    return at(today, add, part(17));
  }
  const dm = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTHS.join("|")})`).exec(p);
  if (dm) {
    const month = MONTHS.indexOf(dm[2]) + 1;
    let year = today.year;
    if (month < today.month || (month === today.month && Number(dm[1]) < today.day)) year++;
    return zonedToUtc({ year, month, day: Number(dm[1]), hour: 17 }, TZ);
  }
  return null;
}

/** The first time phrase in a sentence, if any. */
export function findTimePhrase(sentence: string): string | null {
  return TIME_PATTERN.exec(sentence)?.[0] ?? null;
}
