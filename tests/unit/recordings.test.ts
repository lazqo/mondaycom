import { describe, it, expect } from "vitest";
import { parseRecentOutput, parseDuration, cleanTranscript, parseTranscriptOutput } from "@/lib/recordings/plaud";
import { phoneCandidates, nameCandidates, transcriptPreview, digits } from "@/lib/recordings/match";

// Exactly what `plaud recent` printed on the server.
const RECENT = `
Recordings in the last 7 days: 3

  of_71fa29bc1ec05b366073475a9c2ac83d  Consultation: Greyland Firehouse CCTV System Assessment  2026-09-21  5m37s
  of_0f2c6b844cc96d31d6d090f0a12ebeea  09-21 Reasoning Note: Decision to Defer On-Site Visit Based on Remote Visibility  2026-09-20  27s
  of_4aca14fc00dc097a7d7106448ad998fa  09-21 Meeting: Contact Verification and Noon Appointment with Resina  2026-09-20  45s
`;

const TRANSCRIPT = `Transcript: Consultation: Greyland Firehouse CCTV System Assessment

[00:00 - 00:17] Speaker 1: Not great, But we've got like all the old cameras from previous tinning.
[02:47 - 02:49] Speaker 1: The venue is called Greyland Firehouse.
[03:11 - 03:15] Speaker 2: Yeah. So let's go at one. Right. Thanks, Dave. Cheers.`;

describe("plaud recent output", () => {
  const rows = parseRecentOutput(RECENT);

  it("finds every recording and ignores the header", () => {
    expect(rows).toHaveLength(3);
  });

  it("reads the id, title, date and length", () => {
    expect(rows[0]).toEqual({
      externalId: "of_71fa29bc1ec05b366073475a9c2ac83d",
      title: "Consultation: Greyland Firehouse CCTV System Assessment",
      date: "2026-09-21",
      durationSeconds: 337,
    });
  });

  it("keeps titles that contain colons and dates", () => {
    expect(rows[1].title).toBe("09-21 Reasoning Note: Decision to Defer On-Site Visit Based on Remote Visibility");
    expect(rows[1].durationSeconds).toBe(27);
  });
});

describe("durations", () => {
  it("reads the forms the CLI prints", () => {
    expect(parseDuration("5m37s")).toBe(337);
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("1h02m")).toBe(3720);
    expect(parseDuration("nonsense")).toBeNull();
  });
});

describe("transcripts", () => {
  it("drops the CLI's header line", () => {
    expect(cleanTranscript(TRANSCRIPT).startsWith("[00:00")).toBe(true);
  });

  it("makes a readable preview without timestamps or speaker labels", () => {
    const p = transcriptPreview(cleanTranscript(TRANSCRIPT));
    expect(p).not.toContain("Speaker 1");
    expect(p).not.toContain("[00:00");
    expect(p).toContain("old cameras");
  });
});

describe("matching signals", () => {
  it("picks up NZ phone numbers in any format", () => {
    // Spacing is irrelevant: what matters is that the digits match what is stored on the record.
    expect(phoneCandidates("call me on 021 088 5669 2")).toContain("02108856692");
    expect(phoneCandidates("my number is 02108856692")).toContain("02108856692");
    expect(phoneCandidates("+64 21 555 0123")).toContain("64215550123");
    expect(digits("021 555-0123")).toBe("0215550123");
  });

  it("finds the business name spoken in the call", () => {
    expect(nameCandidates(TRANSCRIPT)).toContain("Greyland Firehouse");
  });

  it("does not offer single common words as a match", () => {
    expect(nameCandidates("the venue is nice")).toHaveLength(0);
  });

  it("finds nothing to match on when there is nothing distinctive", () => {
    expect(phoneCandidates("no numbers here at all")).toHaveLength(0);
  });
});

describe("transcript output", () => {
  it("reads a transcript, cleaned-up or original, without the CLI's header", () => {
    expect(parseTranscriptOutput(`\n${TRANSCRIPT}\n`)?.startsWith("[00:00")).toBe(true);
  });

  it("treats the CLI's notice as no transcript yet", () => {
    expect(parseTranscriptOutput(`No "transaction_polish" transcript for this recording. Available: transaction.`)).toBeNull();
    expect(parseTranscriptOutput("The cleaned-up (polished) transcript hasn't been generated for this recording yet.")).toBeNull();
  });
});
