/**
 * One next step per record (src/lib/next-step.ts): what wins, what supersedes what, and the
 * checklist timings. Pure: no database.
 */
import { describe, it, expect } from "vitest";
import { addDays, dueLabel, nextStepFor, type JobState, type LeadState, type StepContext } from "@/lib/next-step";

const TZ = "Pacific/Auckland";
// A Tuesday, mid-morning in Auckland.
const now = new Date("2026-10-06T10:00:00+13:00");
const ctx: StepContext = { today: "2026-10-06", now, settings: { new_lead_contact_hours: 24, site_visit_quote_days: 2, quote_followup_days: 5, job_invoice_days: 3 }, tz: TZ };
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
const at = (iso: string) => new Date(iso);

const lead = (over: Partial<LeadState> = {}): LeadState => ({
  kind: "lead",
  id: "l1",
  name: "Dean Walker",
  status: "new",
  nextAction: null,
  nextActionFor: null,
  lostReason: null,
  followUpAt: null,
  followUpSetAt: null,
  assignedToId: "u1",
  createdAt: hoursAgo(2),
  lastInboundAt: null,
  tasks: [],
  commitments: [],
  decisions: [],
  events: [],
  quotes: [],
  jobs: [],
  ...over,
});
const job = (over: Partial<JobState> = {}): JobState => ({ kind: "job", id: "j1", number: 1006, title: "Cameras", status: "unscheduled", assignedToId: null, createdAt: hoursAgo(30), doneAt: null, tasks: [], commitments: [], decisions: [], events: [], ...over });

describe("the checklist and stage defaults", () => {
  it("a new lead: contact them, overdue once the contact window has passed", () => {
    expect(nextStepFor(lead(), ctx)).toMatchObject({ what: "Contact Dean", kind: "checklist", due: "2026-10-06", overdue: false, assignedToId: "u1" });
    expect(nextStepFor(lead({ createdAt: hoursAgo(50) }), ctx)).toMatchObject({ what: "Contact Dean", due: "2026-10-05", overdue: true }); // created Sunday 8 am + 24 h
  });
  it("a visit held with no quote: prepare it, due N days after the visit", () => {
    const held = { id: "e1", kind: "site_visit", title: "Site visit", startsAt: at("2026-10-01T10:00:00+13:00"), endsAt: at("2026-10-01T11:00:00+13:00") };
    expect(nextStepFor(lead({ status: "site_visit", events: [held] }), ctx)).toMatchObject({ what: "Prepare the quote", why: "visit held on 2026-10-01", due: "2026-10-03", overdue: true });
    expect(nextStepFor(lead({ status: "site_visit" }), ctx)).toMatchObject({ what: "Book the site visit", kind: "stage", due: null });
  });
  it("a quote sent with no answer: follow up N days after it went", () => {
    expect(nextStepFor(lead({ status: "quote_sent", quotes: [{ id: "q", number: 1006, status: "sent", sentAt: at("2026-09-28T09:00:00+13:00") }] }), ctx)).toMatchObject({ what: "Follow up on Q-1006", due: "2026-10-03", overdue: true });
  });
  it("a follow-up date you set is the step until it is reached and past", () => {
    expect(nextStepFor(lead({ status: "contacted", followUpAt: "2026-10-09", followUpSetAt: hoursAgo(24) }), ctx)).toMatchObject({ what: "Follow up Dean", due: "2026-10-09", overdue: false });
    expect(nextStepFor(lead({ status: "contacted", followUpAt: "2026-10-02", followUpSetAt: hoursAgo(240) }), ctx)).toMatchObject({ due: "2026-10-02", overdue: true });
  });
  it("quote required: approve, send or finish whichever quote there is", () => {
    expect(nextStepFor(lead({ status: "quote_required", quotes: [{ id: "q", number: 7, status: "draft", sentAt: null }] }), ctx).what).toBe("Finish Q-7");
    expect(nextStepFor(lead({ status: "quote_required" }), ctx).what).toBe("Prepare the quote");
  });
  it("lost and won leads are closed, or point at the job", () => {
    expect(nextStepFor(lead({ status: "lost", lostReason: "Went elsewhere" }), ctx)).toMatchObject({ what: "Went elsewhere", kind: "closed" });
    expect(nextStepFor(lead({ status: "won", jobs: [{ id: "j", number: 12, status: "scheduled" }] }), ctx)).toMatchObject({ what: "Job J-12 in hand", kind: "closed" });
    expect(nextStepFor(lead({ status: "won" }), ctx)).toMatchObject({ what: "Convert to a job", kind: "stage", due: null });
  });
});

describe("what supersedes what", () => {
  it("a decision waiting on Chris is the step, whatever the checklist says; a promise due the same day comes first", () => {
    const l = lead({ createdAt: hoursAgo(80), decisions: [{ id: "a1", type: "action", what: "Decide: pencil in the site visit" }] });
    expect(nextStepFor(l, ctx)).toMatchObject({ what: "Decide: pencil in the site visit", kind: "decision", due: "2026-10-06", source: { type: "action", id: "a1" } });
    const promised = lead({ ...l, commitments: [{ id: "c1", owner: "get_secure", ownerName: "Chris", action: "send the quote", dueAt: at("2026-10-06T21:00:00+13:00"), dueText: "tonight" }] });
    expect(nextStepFor(promised, ctx)).toMatchObject({ what: "Send the quote", kind: "commitment" });
  });
  it("a promise we made beats a task due later; the earliest due wins", () => {
    const l = lead({
      status: "contacted",
      commitments: [{ id: "c1", owner: "get_secure", ownerName: "Chris", action: "send the quote", dueAt: at("2026-10-06T21:00:00+13:00"), dueText: "tonight" }],
      tasks: [{ id: "t1", title: "Ring about the alarm", dueAt: "2026-10-08", assignedToId: null, kind: "call", detail: null }],
    });
    expect(nextStepFor(l, ctx)).toMatchObject({ what: "Send the quote", why: "you promised tonight", due: "2026-10-06", kind: "commitment" });
    const overdueTask = lead({ status: "contacted", commitments: l.commitments, tasks: [{ ...l.tasks[0], dueAt: "2026-10-02" }] });
    expect(nextStepFor(overdueTask, ctx)).toMatchObject({ what: "Ring about the alarm", overdue: true, kind: "task", source: { type: "task", id: "t1" } });
  });
  it("a specific plan on the record replaces the checklist nag", () => {
    const l = lead({ createdAt: hoursAgo(80), tasks: [{ id: "t1", title: "Ring Dean about the alarm", dueAt: "2026-10-07", assignedToId: "u2", kind: "call", detail: null }] });
    expect(nextStepFor(l, ctx)).toMatchObject({ what: "Ring Dean about the alarm", due: "2026-10-07", overdue: false, assignedToId: "u2" });
  });
  it("Chris's typed next action for this stage is the step, with the follow-up date as its date", () => {
    const l = lead({ status: "quote_sent", nextAction: "Ring Tuesday after 3", nextActionFor: "quote_sent", followUpAt: "2026-10-07", followUpSetAt: hoursAgo(5) });
    expect(nextStepFor(l, ctx)).toMatchObject({ what: "Ring Tuesday after 3", kind: "typed", due: "2026-10-07" });
    // Hermes's recommended-action label on a lead it created (no stage recorded) is not Chris's note.
    expect(nextStepFor(lead({ status: "new", nextAction: "Prepare quote", nextActionFor: null }), ctx)).toMatchObject({ what: "Contact Dean", kind: "checklist" });
    // Written for an earlier stage: not shown any more.
    expect(nextStepFor(lead({ status: "quote_sent", nextAction: "Ring Tuesday after 3", nextActionFor: "new" }), ctx).kind).not.toBe("typed");
  });
  it("a follow-up set before the customer's latest contact no longer applies", () => {
    const stale = lead({ status: "contacted", followUpAt: "2026-10-09", followUpSetAt: at("2026-10-01T09:00:00+13:00"), lastInboundAt: at("2026-10-05T15:00:00+13:00") });
    expect(nextStepFor(stale, ctx)).toMatchObject({ what: "Follow up Dean", why: "they wrote on 2026-10-05", due: "2026-10-06", kind: "stage" });
    const fresh = lead({ ...stale, followUpSetAt: at("2026-10-05T16:00:00+13:00") });
    expect(nextStepFor(fresh, ctx)).toMatchObject({ due: "2026-10-09", kind: "checklist" });
    // What Hermes made from that contact is the step instead.
    const withTask = lead({ ...stale, tasks: [{ id: "t", title: "Send the revised layout", dueAt: "2026-10-07", assignedToId: null, kind: "task", detail: null }] });
    expect(nextStepFor(withTask, ctx).what).toBe("Send the revised layout");
  });
  it("an appointment ahead is the step when nothing is due before it", () => {
    const visit = { id: "e1", kind: "site_visit", title: "Site visit", startsAt: at("2026-10-08T15:00:00+13:00"), endsAt: at("2026-10-08T16:00:00+13:00") };
    const s = nextStepFor(lead({ status: "site_visit", events: [visit] }), ctx);
    expect(s).toMatchObject({ what: "Site visit", kind: "appointment", due: "2026-10-08", at: visit.startsAt.toISOString() });
    expect(dueLabel(s, ctx.today, TZ)).toBe("Thu 8 Oct 3:00 pm");
    const withTask = lead({ status: "site_visit", events: [visit], tasks: [{ id: "t", title: "Check the NVR stock", dueAt: "2026-10-07", assignedToId: null, kind: "task", detail: null }] });
    expect(nextStepFor(withTask, ctx).what).toBe("Check the NVR stock");
  });
  it("waiting on the customer holds the record until their date, then the step is to chase", () => {
    const theirs = { id: "c2", owner: "customer", ownerName: "Dean", action: "send the photos of the eaves", dueAt: at("2026-10-08T12:00:00+13:00"), dueText: "tomorrow" };
    const s = nextStepFor(lead({ status: "contacted", commitments: [theirs] }), ctx);
    expect(s).toMatchObject({ what: "Nothing until Dean send the photos of the eaves", kind: "waiting", waiting: true, due: "2026-10-08", overdue: false });
    // Waiting replaces the checklist: a brand-new lead whose customer promised photos is not "Contact them".
    expect(nextStepFor(lead({ status: "new", commitments: [theirs] }), ctx).kind).toBe("waiting");
    // Specific work with no date still comes before waiting; a stage default does not.
    expect(nextStepFor(lead({ status: "contacted", commitments: [theirs], tasks: [{ id: "t", title: "Order the cable", dueAt: null, assignedToId: null, kind: "task", detail: null }] }), ctx).what).toBe("Order the cable");
    expect(dueLabel(s, ctx.today, TZ)).toBe("by Thu 8 Oct");
    // Hermes's check-in task on that promise is the wait itself, not a second step.
    const check = { id: "t2", title: "Check: customer said they'd send the photos of the eaves", dueAt: "2026-10-10", assignedToId: null, kind: "follow_up", detail: null };
    expect(nextStepFor(lead({ status: "contacted", commitments: [theirs], tasks: [check] }), ctx)).toMatchObject({ kind: "waiting", why: "they said tomorrow; check in 2026-10-10" });
    const late = nextStepFor(lead({ status: "contacted", commitments: [{ ...theirs, dueAt: at("2026-10-02T12:00:00+13:00") }] }), ctx);
    expect(late).toMatchObject({ what: "Chase Dean: send the photos of the eaves", kind: "chase", due: "2026-10-06", overdue: false });
  });
});

describe("jobs", () => {
  it("unscheduled, scheduled, on site, done: one step each", () => {
    expect(nextStepFor(job(), ctx)).toMatchObject({ what: "Schedule J-1006", due: "2026-10-06" });
    const ev = { id: "e", kind: "job", title: "#1006", startsAt: at("2026-10-07T09:00:00+13:00"), endsAt: at("2026-10-07T13:00:00+13:00") };
    expect(nextStepFor(job({ status: "scheduled", events: [ev] }), ctx)).toMatchObject({ what: "J-1006 on site", kind: "appointment", due: "2026-10-07" });
    const past = { ...ev, startsAt: at("2026-10-02T09:00:00+13:00"), endsAt: at("2026-10-02T13:00:00+13:00") };
    expect(nextStepFor(job({ status: "scheduled", events: [past] }), ctx)).toMatchObject({ what: "Mark J-1006 done, or move it", due: "2026-10-02", overdue: true });
    expect(nextStepFor(job({ status: "on_site" }), ctx).what).toBe("Finish J-1006 and mark it done");
    expect(nextStepFor(job({ status: "done", doneAt: at("2026-09-30T16:00:00+13:00") }), ctx)).toMatchObject({ what: "Invoice J-1006", due: "2026-10-03", overdue: true });
    expect(nextStepFor(job({ status: "invoiced" }), ctx).kind).toBe("closed");
  });
  it("a task on the job replaces the checklist step", () => {
    expect(nextStepFor(job({ status: "done", tasks: [{ id: "t", title: "Send the as-built drawing", dueAt: null, assignedToId: null, kind: "task", detail: null }] }), ctx).what).toBe("Send the as-built drawing");
  });
});

describe("labels", () => {
  it("today, tomorrow, a day, or was due", () => {
    expect(dueLabel({ due: "2026-10-06", at: null, overdue: false, waiting: false }, ctx.today, TZ)).toBe("today");
    expect(dueLabel({ due: "2026-10-07", at: null, overdue: false, waiting: false }, ctx.today, TZ)).toBe("tomorrow");
    expect(dueLabel({ due: "2026-10-09", at: null, overdue: false, waiting: false }, ctx.today, TZ)).toBe("Fri 9 Oct");
    expect(dueLabel({ due: "2026-10-03", at: null, overdue: true, waiting: false }, ctx.today, TZ)).toBe("was due 3 Oct");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });
});
