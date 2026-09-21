/**
 * Follow-up automation engine against the real database: rules create one reminder per entity,
 * re-runs never duplicate, resolved conditions auto-close, dismissed reminders stay dismissed,
 * and scheduling a job notifies the assignee exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("@/db");
const { users, leads, contacts, quotes, jobs, events, tasks, notifications } = await import("@/db/schema");
const { runAutomations, notifyJobScheduled } = await import("@/lib/automations/runner");
const { saveAutomationSettings } = await import("@/lib/settings");

const RUN = `auto${Date.now().toString(36)}`;
const DAY = 86400000;
let userId: string;
let contactId: string;
const leadIds: string[] = [];
let quoteId: string;
let jobId: string;

beforeAll(async () => {
  await saveAutomationSettings({ new_lead_contact_hours: 24, site_visit_quote_days: 2, quote_followup_days: 5, job_invoice_days: 3 });
  const [u] = await db.insert(users).values({ email: `${RUN}@test.local`, name: "Auto Tester", passwordHash: "x" }).returning({ id: users.id });
  userId = u.id;
  const [c] = await db.insert(contacts).values({ name: `Contact ${RUN}` }).returning({ id: contacts.id });
  contactId = c.id;
  const stale = new Date(Date.now() - 3 * DAY);
  const inserted = await db
    .insert(leads)
    .values([
      { name: `Stale new lead ${RUN}`, status: "new", createdAt: stale, assignedToId: userId },
      { name: `Fresh new lead ${RUN}`, status: "new" },
      { name: `Follow-up due ${RUN}`, status: "contacted", followUpAt: new Date(Date.now() - DAY).toISOString().slice(0, 10) },
      { name: `Visited no quote ${RUN}`, status: "site_visit" },
    ])
    .returning({ id: leads.id });
  leadIds.push(...inserted.map((r) => r.id));
  await db.insert(events).values({ title: "Site visit", kind: "site_visit", leadId: leadIds[3], startsAt: new Date(Date.now() - 4 * DAY), endsAt: new Date(Date.now() - 4 * DAY + 3600000) });
  const [q] = await db.insert(quotes).values({ number: 900000 + Math.floor(Math.random() * 90000), title: `Quote ${RUN}`, contactId, leadId: leadIds[2], status: "sent", sentAt: new Date(Date.now() - 10 * DAY) }).returning({ id: quotes.id });
  quoteId = q.id;
  const [j] = await db.insert(jobs).values({ number: 800000 + Math.floor(Math.random() * 90000), title: `Job ${RUN}`, contactId, status: "done", doneAt: new Date(Date.now() - 5 * DAY), assignedToId: userId, siteAddress: "1 Test St" }).returning({ id: jobs.id });
  jobId = j.id;
});

afterAll(async () => {
  await db.delete(tasks).where(inArray(tasks.leadId, leadIds));
  await db.delete(leads).where(inArray(leads.id, leadIds));
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await db.delete(quotes).where(eq(quotes.id, quoteId));
  await db.delete(contacts).where(eq(contacts.id, contactId));
  await db.delete(users).where(eq(users.id, userId));
});

async function openTasksFor() {
  return db.query.tasks.findMany({
    where: and(eq(tasks.status, "open")),
    columns: { id: true, ruleKey: true, entityId: true, title: true, assignedToId: true },
  });
}

describe("runAutomations", () => {
  it("creates one reminder per rule and entity", async () => {
    const s = await runAutomations();
    expect(s.created).toBeGreaterThanOrEqual(5);
    const open = await openTasksFor();
    const byKey = (k: string, e: string) => open.find((t) => t.ruleKey === k && t.entityId === e);
    expect(byKey("lead_not_contacted", leadIds[0])).toBeTruthy();
    expect(byKey("lead_not_contacted", leadIds[1])).toBeFalsy(); // fresh lead is within the window
    expect(byKey("lead_followup_due", leadIds[2])).toBeTruthy();
    expect(byKey("site_visit_no_quote", leadIds[3])).toBeTruthy();
    expect(byKey("quote_no_response", quoteId)).toBeTruthy();
    expect(byKey("job_not_invoiced", jobId)).toBeTruthy();
    // Assigned reminders notify the assignee.
    const n = await db.query.notifications.findFirst({ where: and(eq(notifications.userId, userId), eq(notifications.kind, "task")) });
    expect(n?.title).toContain("Stale new lead");
  });

  it("is idempotent", async () => {
    const before = (await openTasksFor()).length;
    const s = await runAutomations();
    expect(s.created).toBe(0);
    expect((await openTasksFor()).length).toBe(before);
  });

  it("auto-resolves when the condition clears", async () => {
    await db.update(leads).set({ status: "contacted" }).where(eq(leads.id, leadIds[0]));
    await db.update(jobs).set({ status: "invoiced", invoicedAt: new Date() }).where(eq(jobs.id, jobId));
    const s = await runAutomations();
    expect(s.resolved).toBeGreaterThanOrEqual(2);
    const open = await openTasksFor();
    expect(open.find((t) => t.ruleKey === "lead_not_contacted" && t.entityId === leadIds[0])).toBeFalsy();
    expect(open.find((t) => t.ruleKey === "job_not_invoiced" && t.entityId === jobId)).toBeFalsy();
    const closed = await db.query.tasks.findFirst({ where: and(eq(tasks.ruleKey, "job_not_invoiced"), eq(tasks.entityId, jobId)) });
    expect(closed?.status).toBe("done");
    expect(closed?.detail).toContain("resolved automatically");
  });

  it("does not recreate a dismissed reminder", async () => {
    const t = (await openTasksFor()).find((x) => x.ruleKey === "quote_no_response" && x.entityId === quoteId)!;
    await db.update(tasks).set({ status: "dismissed", completedAt: new Date() }).where(eq(tasks.id, t.id));
    await runAutomations();
    const again = (await openTasksFor()).find((x) => x.ruleKey === "quote_no_response" && x.entityId === quoteId);
    expect(again).toBeFalsy();
  });
});

describe("notifyJobScheduled", () => {
  it("notifies the assignee once per schedule", async () => {
    const job = { id: jobId, number: 1, title: `Job ${RUN}`, siteAddress: "1 Test St", assignedToId: userId };
    const start = new Date(Date.now() + DAY);
    const end = new Date(start.getTime() + 2 * 3600000);
    await notifyJobScheduled(job, start, end);
    await notifyJobScheduled(job, start, end);
    const rows = await db.query.notifications.findMany({ where: and(eq(notifications.userId, userId), eq(notifications.kind, "job_scheduled")) });
    expect(rows).toHaveLength(1);
    expect(rows[0].link).toBe(`/jobs/${jobId}`);
    await notifyJobScheduled(job, new Date(start.getTime() + DAY), new Date(end.getTime() + DAY));
    expect((await db.query.notifications.findMany({ where: and(eq(notifications.userId, userId), eq(notifications.kind, "job_scheduled")) })).length).toBe(2);
  });
});
