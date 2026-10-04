/**
 * The "Next action" shown beside a lead's status. Chris can type his own; otherwise each stage has a
 * sensible default worked out from what the CRM already knows (visits booked, quotes, jobs). A typed
 * next action belongs to the stage it was written for: once the lead moves on, the new stage's
 * default shows instead, so the column never shows yesterday's step. Lost leads show the lost reason.
 * Plain module (server and client).
 */
import type { LeadStatus, QuoteStatus } from "@/lib/constants";

export type NextActionInput = {
  status: LeadStatus;
  nextAction: string | null;
  /** The stage the typed next action was written for (null: set when the lead was created). */
  nextActionFor: LeadStatus | null;
  lostReason: string | null;
  followUpAt: string | null;
};

export type NextActionContext = {
  /** YYYY-MM-DD in the business's time zone. */
  today: string;
  siteVisits: { startsAt: Date | string }[];
  quotes: { number: number; status: QuoteStatus }[];
  jobs: { number: number }[];
};

export type NextAction = {
  text: string;
  /** typed: Chris's words; suggested: the stage default; missing: nothing yet (a lost reason). */
  kind: "typed" | "suggested" | "missing";
  /** Past its follow-up date. */
  overdue?: boolean;
};

const shortDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-NZ", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** The typed next action, if it still belongs to the lead's current stage. */
export function typedNextAction(l: Pick<NextActionInput, "status" | "nextAction" | "nextActionFor">): string | null {
  const text = l.nextAction?.trim();
  if (!text) return null;
  return (l.nextActionFor ?? "new") === l.status ? text : null;
}

function followUp(base: string, followUpAt: string | null, today: string): NextAction {
  if (!followUpAt) return { text: base, kind: "suggested" };
  if (followUpAt < today) return { text: `${base} (was due ${shortDate(followUpAt)})`, kind: "suggested", overdue: true };
  return { text: `${base} ${followUpAt === today ? "today" : shortDate(followUpAt)}`, kind: "suggested" };
}

export function nextActionFor(l: NextActionInput, ctx: NextActionContext): NextAction {
  if (l.status === "lost") return l.lostReason?.trim() ? { text: l.lostReason.trim(), kind: "typed" } : { text: "Add the reason", kind: "missing" };
  const typed = typedNextAction(l);
  if (typed) return { text: typed, kind: "typed" };

  const now = Date.now();
  const time = (d: Date | string) => new Date(d).getTime();
  const quote = (statuses: QuoteStatus[]) => ctx.quotes.find((q) => statuses.includes(q.status));
  switch (l.status) {
    case "new":
      return { text: "Contact the customer", kind: "suggested" };
    case "contacted":
      return followUp("Follow up", l.followUpAt, ctx.today);
    case "site_visit": {
      const upcoming = ctx.siteVisits.filter((v) => time(v.startsAt) >= now).sort((a, b) => time(a.startsAt) - time(b.startsAt))[0];
      if (upcoming) {
        const d = new Date(upcoming.startsAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", timeZone: process.env.APP_TIMEZONE ?? "Pacific/Auckland" });
        return { text: `Site visit ${d}`, kind: "suggested" };
      }
      return ctx.siteVisits.length ? { text: "Prepare the quote", kind: "suggested" } : { text: "Book the site visit", kind: "suggested" };
    }
    case "quote_required": {
      const approved = quote(["approved"]);
      if (approved) return { text: `Send quote Q-${approved.number}`, kind: "suggested" };
      const toReview = quote(["needs_review", "ai_prepared", "draft"]);
      if (toReview) return { text: `Review and approve Q-${toReview.number}`, kind: "suggested" };
      return { text: "Prepare the quote", kind: "suggested" };
    }
    case "quote_sent":
      return followUp("Follow up on the quote", l.followUpAt, ctx.today);
    case "won":
      if (ctx.jobs.length) return { text: `Job J-${ctx.jobs[0].number} created`, kind: "suggested" };
      return { text: "Convert to a job", kind: "suggested" };
  }
}
