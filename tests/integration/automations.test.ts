/**
 * Next steps against the real database: one step per lead and job from its state; a Hermes task,
 * a promise or a proposal replaces the checklist; a follow-up set before the customer wrote no
 * longer applies; the checklist run closes tasks on lost leads and resolves the old rules'
 * reminders as their conditions clear; the one-off replacement closes them all on Chris's click,
 * with a summary first; scheduling a job notifies the assignee exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("@/db");
const { users, leads, contacts, quotes, jobs, events, tasks, commitments, notifications, emails, emailThreads, mailboxes, appSettings } = await import("@/db/schema");
const { encryptSecret } = await import("@/lib/crypto");
const { runAutomations, notifyJobScheduled, legacyReminderSummary, replaceLegacyReminders, LEGACY_REPLACED_KEY } = await import("@/lib/automations/runner");
const { listNextSteps, nextStepForLead, nextStepForJob } = await import("@/queries/next-steps");
const { saveAutomationSettings } = await import("@/lib/settings");

const RUN = `auto${Date.now().toString(36)}`;
const DAY = 86400000;
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
let userId: string;
let contactId: string;
const leadIds: string[] = [];
let quoteId: string;
let jobId: string;
let threadId: string;
let mailboxId: string;
const emailIds: string[] = [];

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
      { name: `Follow-up due ${RUN}`, status: "contacted", followUpAt: ymd(new Date(Date.now() - DAY)), followUpSetAt: new Date(Date.now() - 2 * DAY) },
      { name: `Visited no quote ${RUN}`, status: "site_visit" },
      { name: `Wrote since ${RUN}`, status: "contacted", followUpAt: ymd(new Date(Date.now() + 3 * DAY)), followUpSetAt: new Date(Date.now() - 2 * DAY) },
    ])
    .returning({ id: leads.id });
  leadIds.push(...inserted.map((r) => r.id));
  await db.insert(events).values({ title: "Site visit", kind: "site_visit", leadId: leadIds[3], startsAt: new Date(Date.now() - 4 * DAY), endsAt: new Date(Date.now() - 4 * DAY + 3600000) });
  const [q] = await db.insert(quotes).values({ number: 900000 + Math.floor(Math.random() * 90000), title: `Quote ${RUN}`, contactId, leadId: leadIds[2], status: "sent", sentAt: new Date(Date.now() - 10 * DAY) }).returning({ id: quotes.id });
  quoteId = q.id;
  const [j] = await db.insert(jobs).values({ number: 800000 + Math.floor(Math.random() * 90000), title: `Job ${RUN}`, contactId, status: "done", doneAt: new Date(Date.now() - 5 * DAY), assignedToId: userId, siteAddress: "1 Test St" }).returning({ id: jobs.id });
  jobId = j.id;
  // The customer wrote yesterday on the "wrote since" lead, after its follow-up was set.
  const yesterday = new Date(Date.now() - DAY);
  const [mb] = await db.insert(mailboxes).values({ name: `Auto ${RUN}`, emailAddress: `auto+${RUN}@getsecure.test`, imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false, username: "x", passwordEncrypted: encryptSecret("x"), active: false }).returning({ id: mailboxes.id });
  mailboxId = mb.id;
  const [t] = await db.insert(emailThreads).values({ mailboxId, subject: `Thread ${RUN}`, normalizedSubject: `thread ${RUN}`, firstMessageAt: yesterday, lastMessageAt: yesterday, leadId: leadIds[4] }).returning({ id: emailThreads.id });
  threadId = t.id;
  const [e] = await db.insert(emails).values({ mailboxId, threadId, messageId: `<wrote-${RUN}@test>`, direction: "inbound", fromAddress: `wrote+${RUN}@example.com`, fromName: "Wrote Since", to: [{ name: "Get Secure", address: "sales@test.local" }], subject: `Thread ${RUN}`, textBody: "Hi, any news?", receivedAt: yesterday, leadId: leadIds[4], classification: "lead" }).returning({ id: emails.id });
  emailIds.push(e.id);
});

afterAll(async () => {
  await db.delete(tasks).where(inArray(tasks.leadId, leadIds));
  await db.delete(commitments).where(inArray(commitments.leadId, leadIds));
  await db.delete(emails).where(inArray(emails.id, emailIds));
  await db.delete(emailThreads).where(eq(emailThreads.id, threadId));
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
  await db.delete(leads).where(inArray(leads.id, leadIds));
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await db.delete(quotes).where(eq(quotes.id, quoteId));
  await db.delete(contacts).where(eq(contacts.id, contactId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(appSettings).where(eq(appSettings.key, LEGACY_REPLACED_KEY));
});

const stepOf = async (leadId: string) => (await nextStepForLead(leadId))!;

describe("one next step per record", () => {
  it("the checklist: an untouched new lead, a visit with no quote, a quote with no answer, a follow-up reached, a job not invoiced", async () => {
    expect(await stepOf(leadIds[0])).toMatchObject({ what: "Contact Stale", kind: "checklist", overdue: true, assignedToId: userId });
    expect(await stepOf(leadIds[1])).toMatchObject({ what: "Contact Fresh", overdue: false });
    expect(await stepOf(leadIds[3])).toMatchObject({ what: "Prepare the quote", overdue: true });
    // The quote is on the "follow-up due" lead but that lead is Contacted: the follow-up date is the step.
    expect(await stepOf(leadIds[2])).toMatchObject({ what: "Follow up Follow-up", kind: "checklist", overdue: true });
    expect((await nextStepForJob(jobId))!).toMatchObject({ what: expect.stringMatching(/^Invoice J-/), overdue: true });
    const all = await listNextSteps();
    const ids = [...all.overdue, ...all.dueToday, ...all.later, ...all.waiting].map((r) => r.record.id);
    for (const id of [...leadIds, jobId]) expect(ids).toContain(id);
    expect(all.overdue.map((r) => r.record.id)).toContain(jobId);
  });

  it("a follow-up set before the customer's latest email no longer applies", async () => {
    const s = await stepOf(leadIds[4]);
    expect(s).toMatchObject({ what: "Follow up Wrote", kind: "stage", due: ymd(new Date()) });
    expect(s.why).toMatch(/they wrote on/);
    // Set again (after the email): it applies.
    await db.update(leads).set({ followUpSetAt: new Date() }).where(eq(leads.id, leadIds[4]));
    expect(await stepOf(leadIds[4])).toMatchObject({ kind: "checklist", due: ymd(new Date(Date.now() + 3 * DAY)) });
  });

  it("a task, a promise or a proposal on the record replaces the checklist; the earliest due wins; done, the checklist returns", async () => {
    const [t] = await db.insert(tasks).values({ title: `Ring about the alarm ${RUN}`, leadId: leadIds[0], dueAt: ymd(new Date(Date.now() + DAY)), kind: "call", ruleKey: "inspector:CALL_CUSTOMER:x", entityId: leadIds[0] }).returning({ id: tasks.id });
    expect(await stepOf(leadIds[0])).toMatchObject({ what: `Ring about the alarm ${RUN}`, kind: "task", overdue: false, source: { type: "task", id: t.id } });
    const [c] = await db.insert(commitments).values({ owner: "get_secure", ownerName: "Chris", action: "send the quote", actionKey: "send_quote", dueAt: new Date(Date.now() + 3600000), dueText: "tonight", confidence: "0.9", leadId: leadIds[0], sourceType: "recording", sourceId: leadIds[0] }).returning({ id: commitments.id });
    expect(await stepOf(leadIds[0])).toMatchObject({ what: "Send the quote", kind: "commitment", source: { type: "commitment", id: c.id } });
    await db.update(commitments).set({ status: "done" }).where(eq(commitments.id, c.id));
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, t.id));
    expect(await stepOf(leadIds[0])).toMatchObject({ what: "Contact Stale", kind: "checklist" });
  });

  it("waiting on the customer holds the record; past their date the step is to chase them", async () => {
    const [c] = await db.insert(commitments).values({ owner: "customer", ownerName: "Fresh", action: "send the photos", actionKey: "send_photos", dueAt: new Date(Date.now() + 2 * DAY), dueText: "Thursday", confidence: "0.9", leadId: leadIds[1], sourceType: "recording", sourceId: leadIds[1] }).returning({ id: commitments.id });
    // The wait replaces the checklist's "Contact Fresh": nothing to do until the photos come.
    expect(await stepOf(leadIds[1])).toMatchObject({ what: "Nothing until Fresh send the photos", kind: "waiting", waiting: true });
    expect((await listNextSteps()).waiting.map((r) => r.record.id)).toContain(leadIds[1]);
    await db.update(commitments).set({ dueAt: new Date(Date.now() - DAY) }).where(eq(commitments.id, c.id));
    expect(await stepOf(leadIds[1])).toMatchObject({ what: "Chase Fresh: send the photos", kind: "chase", due: ymd(new Date()) });
    await db.update(commitments).set({ status: "done" }).where(eq(commitments.id, c.id));
  });
});

describe("the checklist run", () => {
  it("creates nothing; closes tasks on a lost lead; the summary counts what is due", async () => {
    const [t] = await db.insert(tasks).values({ title: `Price the quote ${RUN}`, leadId: leadIds[3], ruleKey: "inspector:PREPARE_QUOTE:quote_ready", entityId: leadIds[3], kind: "quote" }).returning({ id: tasks.id });
    const before = (await db.query.tasks.findMany({ where: eq(tasks.status, "open"), columns: { id: true } })).length;
    const s1 = await runAutomations();
    expect(s1.created ?? 0).toBe(0);
    expect((await db.query.tasks.findMany({ where: eq(tasks.status, "open"), columns: { id: true } })).length).toBe(before);
    expect(s1.overdue).toBeGreaterThanOrEqual(2);
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, t.id) }))!.status).toBe("open");
    await db.update(leads).set({ status: "lost", lostReason: "Went elsewhere" }).where(eq(leads.id, leadIds[3]));
    const s2 = await runAutomations();
    expect(s2.closed).toBeGreaterThanOrEqual(1);
    const closed = (await db.query.tasks.findFirst({ where: eq(tasks.id, t.id) }))!;
    expect(closed.status).toBe("done");
    expect(closed.detail).toContain("the lead was marked lost");
  });

  it("the old rules' reminders: resolved as their condition clears; summarised; replaced in one go on Chris's click", async () => {
    // Two reminders the old rules would have made (one whose condition still holds, one whose does not).
    const [keep] = await db.insert(tasks).values({ title: `Contact new lead: Stale ${RUN}`, leadId: leadIds[0], ruleKey: "lead_not_contacted", entityId: leadIds[0] }).returning({ id: tasks.id });
    const [gone] = await db.insert(tasks).values({ title: `Invoice job ${RUN}`, jobId, ruleKey: "job_not_invoiced", entityId: jobId }).returning({ id: tasks.id });
    await db.update(jobs).set({ status: "invoiced", invoicedAt: new Date() }).where(eq(jobs.id, jobId));
    const s = await runAutomations();
    expect(s.resolved).toBeGreaterThanOrEqual(1);
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, gone.id) }))!).toMatchObject({ status: "done" });
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, keep.id) }))!.status).toBe("open");
    const summary = await legacyReminderSummary();
    expect(summary.total).toBeGreaterThanOrEqual(1);
    expect(summary.perRule.find((r) => r.key === "lead_not_contacted")!.count).toBeGreaterThanOrEqual(1);
    expect(summary.replacedAt).toBeNull();
    const r = await replaceLegacyReminders(userId);
    expect(r.count).toBeGreaterThanOrEqual(1);
    const after = (await db.query.tasks.findFirst({ where: eq(tasks.id, keep.id) }))!;
    expect(after.status).toBe("done");
    expect(after.detail).toContain("replaced by the record's next step");
    expect((await legacyReminderSummary()).total).toBe(0);
    expect((await legacyReminderSummary()).replacedCount).toBe(r.count);
    // The lead still has its one step.
    expect(await stepOf(leadIds[0])).toMatchObject({ what: "Contact Stale" });
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
