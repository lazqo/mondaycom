/**
 * Text helpers for the Inspector: transcript turns, sentences, and which speaker is Get Secure.
 * Pure: no database.
 */
import type { Utterance } from "./types";

/**
 * Plaud transcripts look like "[00:00 - 00:05] Speaker 1: text" (original) or "Chris: text" /
 * "**Speaker 2:** text" (cleaned). Lines without a speaker continue the previous turn.
 */
export function parseTranscript(text: string): Utterance[] {
  const out: Utterance[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*-\s*\d{1,2}:\d{2}(?::\d{2})?)?\]\s*)?(?:\*\*)?([A-Z][\w .'-]{0,30}?)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/.exec(line);
    if (m && !/^(https?|note|subject|re|date|time)$/i.test(m[2].trim())) {
      out.push({ speaker: m[2].trim(), text: m[3].trim(), at: m[1] ?? null });
    } else if (out.length) {
      out[out.length - 1].text += ` ${line}`;
    } else {
      out.push({ speaker: null, text: line, at: null });
    }
  }
  return out;
}

/** Sentences, keeping each one's words intact for evidence. */
export function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

const GS_PHRASES = [
  /\bget secure\b/i,
  /\bi'?ll (send|email|get) (you|the|a|that|it)\b.*\bquote\b/i,
  /\bput (a|the) quote together\b/i,
  /\bwe (can|could|would|usually|normally) (install|fit|run|put|mount|recommend|do)\b/i,
  /\bwe'?d (recommend|suggest|go with|put)\b/i,
  /\bour (team|technician|installer|installers|guys)\b/i,
  /\bi'?ll come (out|round|over)\b/i,
  /\b(cat ?6|nvr|poe|recorder|hard drive|terabyte|megapixel)\b/i,
  /\bfrom our end\b/i,
];
const CUSTOMER_PHRASES = [
  /\b(my|our) (house|home|place|property|wife|husband|partner|kids|shop|business|driveway|garage)\b/i,
  /\bhow much\b/i,
  /\bcan you (come|do|install|send|quote)\b/i,
  /\bwe'?re (looking|thinking|after)\b/i,
  /\bi'?m (looking|thinking|after)\b/i,
];

/**
 * Which transcript speaker is Get Secure (Chris or staff). By name when the transcript names
 * them; otherwise by what each speaker says. Null when it cannot be told apart safely.
 */
export function getSecureSpeaker(utterances: Utterance[], staffNames: string[]): string | null {
  const speakers = [...new Set(utterances.map((u) => u.speaker).filter((s): s is string => !!s))];
  if (!speakers.length) return null;
  const staff = staffNames.map((n) => n.toLowerCase().split(/\s+/)[0]).filter(Boolean);
  const named = speakers.find((s) => staff.includes(s.toLowerCase().split(/\s+/)[0]) || /get secure/i.test(s));
  if (named) return named;
  // "This is Chris from Get Secure" said by one speaker.
  for (const u of utterances) {
    if (!u.speaker) continue;
    if (staff.some((n) => new RegExp(`\\b(this is|it'?s|i'?m) ${n}\\b`, "i").test(u.text)) || /\bfrom get secure\b/i.test(u.text)) return u.speaker;
  }
  const score = new Map<string, number>();
  for (const u of utterances) {
    if (!u.speaker) continue;
    const gs = GS_PHRASES.filter((r) => r.test(u.text)).length;
    const cu = CUSTOMER_PHRASES.filter((r) => r.test(u.text)).length;
    score.set(u.speaker, (score.get(u.speaker) ?? 0) + gs - cu);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[0][1] - ranked[1][1] >= 2)) return ranked[0][0];
  return null;
}

/** NZ-looking phone numbers in text, digits only. */
export function phonesIn(text: string): string[] {
  const found = text.match(/(?:\+?64|0)[\s-]?[2-9][\d\s-]{6,12}\d/g) ?? [];
  return [...new Set(found.map((p) => p.replace(/\D/g, "")).filter((d) => d.length >= 8 && d.length <= 12))];
}

/** Email addresses in text, other than Get Secure's own. */
export function emailsIn(text: string): string[] {
  const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase()).filter((e) => !/@getsecure\./.test(e)))];
}

/** Normalised phone for comparison (0xx… form). */
export function normalisePhone(p: string): string {
  const d = p.replace(/\D/g, "");
  return d.startsWith("64") ? `0${d.slice(2)}` : d;
}

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, couple: 2 };
export function toNumber(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return WORD_NUMBERS[word.toLowerCase()] ?? null;
}
