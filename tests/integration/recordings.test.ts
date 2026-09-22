/**
 * Recording import against the real database. The Plaud CLI is not invoked; the transcripts are
 * the real ones captured from the device, fed straight to the matcher and the store.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("@/db");
const { recordings, contacts, leads } = await import("@/db/schema");
const { matchRecording } = await import("@/lib/recordings/match");

const RUN = `rec${Date.now().toString(36)}`;
const madeContacts: string[] = [];
const madeLeads: string[] = [];
const madeRecordings: string[] = [];

// The real consultation transcript, trimmed, with the venue name that identifies the customer.
const CONSULT = `[00:00 - 00:17] Speaker 1: We've got all the old cameras from previous tinning.
[02:47 - 02:49] Speaker 1: The venue is called Greyland Firehouse ${RUN}.
[03:11 - 03:15] Speaker 2: So let's go at one. Thanks, Dave.`;

// A note to self: nothing in it identifies a customer.
const SELF_NOTE = `[00:00 - 00:27] Speaker 1: Decided to defer the on site visit because remote visibility was good enough.`;

beforeAll(async () => {
  const [c] = await db
    .insert(contacts)
    .values({ name: `Dave Manager ${RUN}`, company: `Greyland Firehouse ${RUN}`, phone: "021 555 7788" })
    .returning({ id: contacts.id });
  madeContacts.push(c.id);
});

afterAll(async () => {
  if (madeRecordings.length) await db.delete(recordings).where(inArray(recordings.id, madeRecordings));
  if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
  if (madeContacts.length) await db.delete(contacts).where(inArray(contacts.id, madeContacts));
});

describe("matching a recording to a customer", () => {
  it("matches on the business name spoken in the call", async () => {
    const m = await matchRecording({ title: `Consultation: Greyland Firehouse ${RUN} CCTV`, transcript: CONSULT });
    expect(m).not.toBeNull();
    expect(m!.contactId).toBe(madeContacts[0]);
    expect(m!.matchedBy).toContain("name");
  });

  it("matches on a phone number even when it is written differently", async () => {
    const m = await matchRecording({ title: "Call back", transcript: "He asked me to ring 0215557788 tomorrow." });
    expect(m?.contactId).toBe(madeContacts[0]);
    expect(m!.matchedBy).toContain("phone");
  });

  it("leaves a note to self unmatched rather than guessing", async () => {
    expect(await matchRecording({ title: "Reasoning Note", transcript: SELF_NOTE })).toBeNull();
  });

  it("matches an open lead by phone", async () => {
    const [l] = await db
      .insert(leads)
      .values({ name: `Isapela ${RUN}`, phone: "02108856692", status: "new", source: "phone" })
      .returning({ id: leads.id });
    madeLeads.push(l.id);
    const m = await matchRecording({ title: "Call", transcript: "Ring her on 021 0885 6692 about the cameras." });
    expect(m?.leadId).toBe(l.id);
  });
});

describe("storing recordings", () => {
  it("never imports the same recording twice", async () => {
    const values = {
      externalId: `of_${RUN}`,
      source: "plaud",
      title: "Consultation",
      transcript: CONSULT,
      status: "review" as const,
    };
    const [first] = await db.insert(recordings).values(values).onConflictDoNothing().returning({ id: recordings.id });
    madeRecordings.push(first.id);
    const second = await db.insert(recordings).values(values).onConflictDoNothing().returning({ id: recordings.id });
    expect(second).toHaveLength(0);
    const all = await db.query.recordings.findMany({ where: eq(recordings.externalId, `of_${RUN}`) });
    expect(all).toHaveLength(1);
  });
});
