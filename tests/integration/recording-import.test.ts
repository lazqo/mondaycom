/**
 * Importing Plaud recordings through the CLI (a stand-in that prints what the real one does):
 * the cleaned-up transcript is preferred, the original is used until it exists, and recordings
 * already imported are switched to the cleaned-up version once Plaud has made it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray, like } from "drizzle-orm";

const RUN = `ri${Date.now().toString(36)}`;
const STATE = resolve(`test-results/fake-plaud-${RUN}.json`);
process.env.PLAUD_ENABLED = "true";
process.env.PLAUD_CLI = resolve("tests/support/fake-plaud.mjs");
process.env.FAKE_PLAUD_STATE = STATE;

const { db } = await import("@/db");
const { recordings, contacts } = await import("@/db/schema");
const { importRecentRecordings } = await import("@/lib/recordings/import");

type Rec = { id: string; title: string; date: string; duration: string; original: string; polished: string | null };
const A: Rec = {
  id: `of_a${RUN}`,
  title: `Consultation ${RUN}`,
  date: "2026-09-21",
  duration: "5m37s",
  original: "[00:00 - 00:05] Speaker 1: um so yeah the the cameras um",
  polished: "[00:00 - 00:05] Speaker 1: So, the cameras.",
};
const B: Rec = {
  id: `of_b${RUN}`,
  title: `Call back ${RUN}`,
  date: "2026-09-22",
  duration: "45s",
  original: "[00:00 - 00:08] Speaker 1: ring me on oh two one five five five ah",
  polished: null,
};
function setState(list: Rec[]) {
  writeFileSync(STATE, JSON.stringify({ recordings: list }));
}

let contactId: string;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("test-results", { recursive: true });
  const [c] = await db.insert(contacts).values({ name: `Rewi Parata ${RUN}`, phone: "021 555 8812" }).returning({ id: contacts.id });
  contactId = c.id;
});

afterAll(async () => {
  await db.delete(recordings).where(like(recordings.externalId, `%${RUN}`));
  await db.delete(contacts).where(eq(contacts.id, contactId));
});

describe("importing Plaud recordings", () => {
  it("stores the cleaned-up transcript when there is one, and the original until there is", async () => {
    setState([A, B]);
    const s = await importRecentRecordings({});
    expect(s.errors).toEqual([]);
    expect(s.imported).toBe(2);
    const rows = await db.query.recordings.findMany({ where: inArray(recordings.externalId, [A.id, B.id]) });
    const a = rows.find((r) => r.externalId === A.id)!;
    const b = rows.find((r) => r.externalId === B.id)!;
    expect(a.transcript).toBe(A.polished);
    expect(a.transcriptPolished).toBe(true);
    expect(b.transcript).toBe(B.original);
    expect(b.transcriptPolished).toBe(false);
    expect(b.status).toBe("review");
  });

  it("does not ask again straight away for a cleaned-up transcript that is not ready", async () => {
    setState([A, B]);
    const s = await importRecentRecordings({});
    expect(s.imported).toBe(0);
    expect(s.cleaned).toBe(0);
  });

  it("switches to the cleaned-up transcript once Plaud has made it, and files it if that now matches", async () => {
    // Plaud has finished cleaning B up, and the clean text has the number written properly.
    setState([A, { ...B, polished: "[00:00 - 00:08] Speaker 1: Ring me on 021 555 8812." }]);
    await db.update(recordings).set({ polishCheckedAt: new Date(Date.now() - 7 * 3600000) }).where(eq(recordings.externalId, B.id));
    const s = await importRecentRecordings({});
    expect(s.cleaned).toBe(1);
    const b = (await db.query.recordings.findFirst({ where: eq(recordings.externalId, B.id) }))!;
    expect(b.transcriptPolished).toBe(true);
    expect(b.transcript).toContain("021 555 8812");
    expect(b.status).toBe("attached");
    expect(b.contactId).toBe(contactId);
  });

  it("upgrades a recording imported before cleaned-up transcripts were fetched", async () => {
    const old: Rec = { id: `of_c${RUN}`, title: `Old site walk ${RUN}`, date: "2026-08-01", duration: "2m", original: "uh raw text", polished: "Clean text." };
    await db.insert(recordings).values({ externalId: old.id, title: old.title, transcript: old.original, status: "review", createdAt: new Date("2026-08-01T00:00:00Z") });
    setState([old]);
    const s = await importRecentRecordings({});
    expect(s.imported).toBe(0);
    expect(s.cleaned).toBe(1);
    const c = (await db.query.recordings.findFirst({ where: eq(recordings.externalId, old.id) }))!;
    expect(c.transcript).toBe("Clean text.");
  });
});
