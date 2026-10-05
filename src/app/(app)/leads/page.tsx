import type { Metadata } from "next";
import { listLeads, listActiveUsers } from "@/queries";
import { requireOffice } from "@/lib/auth";
import { appDay } from "@/queries/dashboard";
import { LeadsBoard } from "@/components/leads/leads-board";
import { nextStepsForLeads } from "@/queries/next-steps";
import { dueLabel } from "@/lib/next-step";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requireOffice();
  const [{ view }, leads, users] = await Promise.all([searchParams, listLeads(), listActiveUsers()]);
  const today = appDay().today;
  const steps = await nextStepsForLeads(leads.map((l) => l.id));
  const rows = leads.map((l) => {
    // A lost lead's column is its lost reason, edited in place: the board's own rendering handles it.
    const s = l.status === "lost" ? undefined : steps.get(l.id);
    const when = s ? dueLabel(s, today) : null;
    return { ...l, nextStep: s ? { text: s.kind === "closed" || !when ? s.what : `${s.what} · ${when}`, overdue: s.overdue, typed: s.kind === "typed" } : undefined };
  });
  return <LeadsBoard leads={rows} users={users} view={view === "kanban" ? "kanban" : "table"} today={today} />;
}
