import type { JourneyStep } from "@/components/journey/journey-bar";
import type { LeadStatus, QuoteStatus, JobStatus } from "@/lib/constants";

export type JourneyInput = {
  lead?: { id: string; status: LeadStatus; contactId: string | null } | null;
  siteVisits: { startsAt: Date; endsAt: Date }[];
  quotes: { id: string; status: QuoteStatus; number: number }[];
  jobs: { id: string; status: JobStatus; number: number; scheduled: boolean }[];
  contactId?: string | null;
};

/** Which stage of Lead → Site visit → Quote → Job → Done this record is at, plus the next sensible step. */
export function buildJourney(input: JourneyInput, current: "lead" | "quote" | "job"): { steps: JourneyStep[]; cta: { label: string; href: string } | null } {
  const lead = input.lead ?? null;
  const lost = lead?.status === "lost";
  const latestQuote = input.quotes[0] ?? null;
  const latestJob = input.jobs[0] ?? null;
  const visitDone = input.siteVisits.some((v) => v.endsAt < new Date());
  const visitBooked = input.siteVisits.length > 0;
  const jobDone = latestJob ? latestJob.status === "done" || latestJob.status === "invoiced" : false;

  const steps: JourneyStep[] = [
    { key: "lead", label: lead ? "Lead" : "Customer", state: lead ? (current === "lead" && !latestQuote && !latestJob ? "current" : "done") : "done", href: lead ? `/leads/${lead.id}` : input.contactId ? `/contacts/${input.contactId}` : null },
    {
      key: "visit",
      label: visitDone ? "Site visit done" : visitBooked ? "Site visit booked" : "Site visit",
      state: visitDone ? "done" : visitBooked ? "current" : latestQuote || latestJob ? "skipped" : "todo",
      href: lead ? `/leads/${lead.id}` : null,
      hint: visitBooked ? undefined : "Optional: book from the lead page",
    },
    {
      key: "quote",
      label: latestQuote ? `Quote Q-${latestQuote.number} ${latestQuote.status}` : "Quote",
      state: latestQuote ? (latestQuote.status === "accepted" ? "done" : latestQuote.status === "declined" ? "skipped" : "current") : latestJob ? "skipped" : "todo",
      href: latestQuote ? `/quotes/${latestQuote.id}` : null,
    },
    {
      key: "job",
      label: latestJob ? `Job J-${latestJob.number}${latestJob.scheduled ? "" : " unscheduled"}` : "Job",
      state: latestJob ? (jobDone ? "done" : "current") : "todo",
      href: latestJob ? `/jobs/${latestJob.id}` : null,
    },
    { key: "done", label: latestJob?.status === "invoiced" ? "Invoiced" : "Done", state: jobDone ? (latestJob?.status === "invoiced" ? "done" : "current") : "todo" },
  ];
  if (lost) steps.forEach((s) => (s.state = s.state === "done" ? "done" : "skipped"));

  let cta: { label: string; href: string } | null = null;
  if (!lost) {
    if (lead && !lead.contactId && !latestJob) cta = { label: "Convert to customer", href: `/leads/${lead.id}#convert` };
    else if (latestJob && !latestJob.scheduled && !jobDone) cta = { label: "Schedule job", href: `/jobs/${latestJob.id}#schedule` };
    else if (latestJob && !jobDone) cta = { label: "Open job", href: `/jobs/${latestJob.id}` };
    else if (latestJob && latestJob.status === "done") cta = { label: "Mark invoiced", href: `/jobs/${latestJob.id}` };
    else if (!latestQuote && lead?.contactId) cta = { label: "Create quote", href: `/quotes/new?contactId=${lead.contactId}&leadId=${lead.id}` };
    else if (latestQuote && latestQuote.status === "draft") cta = { label: "Send quote", href: `/quotes/${latestQuote.id}` };
    else if (latestQuote && latestQuote.status === "sent") cta = { label: "Record customer's answer", href: `/quotes/${latestQuote.id}` };
    else if (latestQuote && latestQuote.status === "accepted" && !latestJob && input.contactId) cta = { label: "Create job", href: `/jobs/new?contactId=${input.contactId}` };
  }
  if (cta && current === "job" && cta.href.startsWith(`/jobs/${latestJob?.id}`) && !cta.href.includes("#")) cta = null;
  return { steps, cta };
}
