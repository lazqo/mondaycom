import type { Metadata } from "next";
import { listLeads, listActiveUsers } from "@/queries";
import { requireOffice } from "@/lib/auth";
import { LeadsBoard } from "@/components/leads/leads-board";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requireOffice();
  const [{ view }, leads, users] = await Promise.all([searchParams, listLeads(), listActiveUsers()]);
  return <LeadsBoard leads={leads} users={users} view={view === "kanban" ? "kanban" : "table"} />;
}
