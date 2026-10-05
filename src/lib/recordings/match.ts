/**
 * Works out who a recording is about, with the CRM's one set of identity signals
 * (src/lib/inspector/signals.ts). Deliberately conservative: a wrong match files a customer
 * conversation against the wrong person, which is worse than leaving it for Chris, so only a strong
 * signal (a phone number, an email address, a quote or job number, an appointment at that time)
 * files a recording. A spoken name alone never does; the Inspector shows it as a candidate.
 */
import { decideIdentity, mergeCandidates } from "@/lib/inspector/identity";
import { collectSignals } from "@/lib/inspector/signals";
import { normalisePhone, parseTranscript, phonesIn } from "@/lib/inspector/text";

export type RecordingMatch = { contactId: string | null; leadId: string | null; matchedBy: string } | null;

/** Digits only, so "021 088 5669" and "02108856692" compare equal. */
export function digits(s: string): string {
  return s.replace(/\D/g, "");
}

/** Every NZ-looking phone number spoken or written in the text, as digit strings. */
export function phoneCandidates(text: string): string[] {
  return [...new Set(phonesIn(text).map(normalisePhone).filter((d) => d.length >= 8))];
}

/**
 * Find the customer or lead a transcript belongs to. Returns null when nothing strong enough is
 * found, which leaves the recording for Chris (with the Inspector's candidates).
 */
export async function matchRecording(input: { title: string; transcript: string; at?: Date | null }): Promise<RecordingMatch> {
  const signals = await collectSignals({
    sourceType: "recording",
    sourceId: "00000000-0000-0000-0000-000000000000",
    direction: "conversation",
    at: input.at ?? new Date(),
    title: input.title,
    text: input.transcript,
    utterances: parseTranscript(input.transcript),
    from: { name: null, email: null, phone: null },
    context: [],
    linked: { leadId: null, contactId: null, jobId: null, how: null },
  });
  const decided = decideIdentity(mergeCandidates(signals), { allowNew: false });
  if (decided.status !== "matched" || !decided.chosen) return null;
  const strong = decided.chosen.signals.find((s) => ["phone", "email", "quote_ref", "calendar"].includes(s.kind));
  if (!strong) return null;
  return { contactId: decided.chosen.contactId, leadId: decided.chosen.leadId, matchedBy: strong.detail };
}

/** First line or two of a transcript, for list views. */
export function transcriptPreview(transcript: string, max = 220): string {
  const spoken = transcript
    .split("\n")
    .map((l) => l.replace(/^\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\]\s*(Speaker \d+:)?\s*/i, "").trim())
    .filter(Boolean)
    .join(" ");
  return spoken.length > max ? spoken.slice(0, max).trimEnd() + "…" : spoken;
}
