import { describe, it, expect } from "vitest";
import { nextActionFor, typedNextAction, type NextActionInput } from "@/lib/leads/next-action";

const lead = (over: Partial<NextActionInput> = {}): NextActionInput => ({ status: "new", nextAction: null, nextActionFor: null, lostReason: null, followUpAt: null, ...over });
const ctx = { today: "2026-10-04", siteVisits: [], quotes: [], jobs: [] };
const text = (l: Partial<NextActionInput>, c: Partial<typeof ctx> = {}) => nextActionFor(lead(l), { ...ctx, ...c }).text;

describe("Next action beside the status", () => {
  it("each stage has a default", () => {
    expect(text({ status: "new" })).toBe("Contact the customer");
    expect(text({ status: "contacted" })).toBe("Follow up");
    expect(text({ status: "site_visit" })).toBe("Book the site visit");
    expect(text({ status: "quote_required" })).toBe("Prepare the quote");
    expect(text({ status: "quote_sent" })).toBe("Follow up on the quote");
    expect(text({ status: "won" })).toBe("Convert to a job");
    expect(nextActionFor(lead({ status: "won" }), ctx).kind).toBe("suggested");
  });

  it("uses what the CRM knows: visits, quotes, jobs and follow-up dates", () => {
    const soon = new Date(Date.now() + 3 * 86400000);
    expect(text({ status: "site_visit" }, { siteVisits: [{ startsAt: soon }] })).toMatch(/^Site visit \d{1,2} \w{3}$/);
    expect(text({ status: "site_visit" }, { siteVisits: [{ startsAt: new Date(Date.now() - 86400000) }] })).toBe("Prepare the quote");
    expect(text({ status: "quote_required" }, { quotes: [{ number: 1042, status: "needs_review" }] })).toBe("Review and approve Q-1042");
    expect(text({ status: "quote_required" }, { quotes: [{ number: 1042, status: "approved" }] })).toBe("Send quote Q-1042");
    expect(text({ status: "won" }, { jobs: [{ number: 17 }] })).toBe("Job J-17 created");
    expect(text({ status: "quote_sent", followUpAt: "2026-10-09" })).toBe("Follow up on the quote 9 Oct");
    expect(text({ status: "contacted", followUpAt: "2026-10-04" })).toBe("Follow up today");
    const overdue = nextActionFor(lead({ status: "contacted", followUpAt: "2026-10-01" }), ctx);
    expect(overdue).toMatchObject({ text: "Follow up (was due 1 Oct)", overdue: true });
  });

  it("Chris's own words win, but only for the stage they were written for", () => {
    expect(nextActionFor(lead({ status: "quote_sent", nextAction: "Ring Tuesday after 3", nextActionFor: "quote_sent" }), ctx)).toEqual({ text: "Ring Tuesday after 3", kind: "typed" });
    // Written while it was Contacted; it is now Won, so the Won default shows.
    expect(text({ status: "won", nextAction: "Ring Tuesday after 3", nextActionFor: "contacted" })).toBe("Convert to a job");
    // Set when the lead was created from an email (no stage recorded): belongs to New.
    expect(typedNextAction({ status: "new", nextAction: "Call to qualify", nextActionFor: null })).toBe("Call to qualify");
    expect(typedNextAction({ status: "contacted", nextAction: "Call to qualify", nextActionFor: null })).toBeNull();
  });

  it("a lost lead shows its reason, or asks for one", () => {
    expect(nextActionFor(lead({ status: "lost", lostReason: "Went with a cheaper installer" }), ctx)).toEqual({ text: "Went with a cheaper installer", kind: "typed" });
    expect(nextActionFor(lead({ status: "lost" }), ctx)).toEqual({ text: "Add the reason", kind: "missing" });
  });
});
