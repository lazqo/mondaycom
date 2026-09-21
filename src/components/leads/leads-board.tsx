"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, Table2, Plus } from "lucide-react";
import type { LeadRow } from "@/queries";
import { updateLead } from "@/actions/leads";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { LeadStatus } from "@/lib/constants";
import { LeadsTable } from "./leads-table";
import { LeadsKanban } from "./leads-kanban";
import { NewLeadDialog } from "./new-lead-dialog";
import type { UserOption } from "./cells";

export type LeadPatch = Partial<
  Pick<
    LeadRow,
    | "name"
    | "company"
    | "phone"
    | "email"
    | "service"
    | "site"
    | "status"
    | "assignedToId"
    | "followUpAt"
    | "lastContactAt"
    | "source"
  >
>;

export function LeadsBoard({
  leads,
  users,
  view,
}: {
  leads: LeadRow[];
  users: UserOption[];
  view: "table" | "kanban";
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState(leads);
  const [error, setError] = React.useState<string | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [, startTransition] = React.useTransition();

  React.useEffect(() => setRows(leads), [leads]);

  const patchLead = React.useCallback(
    (id: string, patch: LeadPatch) => {
      setError(null);
      let previous: LeadRow | undefined;
      setRows((rs) =>
        rs.map((r) => {
          if (r.id !== id) return r;
          previous = r;
          const next = { ...r, ...patch };
          if (patch.assignedToId !== undefined) {
            next.assignedTo = patch.assignedToId ? (users.find((u) => u.id === patch.assignedToId) ?? null) : null;
          }
          return next;
        }),
      );
      startTransition(async () => {
        const res = await updateLead(id, patch);
        if (!res.ok) {
          setError(res.error);
          if (previous) setRows((rs) => rs.map((r) => (r.id === id ? previous! : r)));
        } else {
          router.refresh();
        }
      });
    },
    [router, users],
  );

  const setStatus = React.useCallback((id: string, status: LeadStatus) => patchLead(id, { status }), [patchLead]);

  const open = rows.filter((r) => r.status !== "won" && r.status !== "lost").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Leads</h1>
          <p className="text-sm text-gray-500">
            {open} open · {rows.length} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-gray-300 bg-white p-0.5">
            <ViewTab href="/leads" active={view === "table"} icon={<Table2 className="h-4 w-4" />} label="Table" />
            <ViewTab
              href="/leads?view=kanban"
              active={view === "kanban"}
              icon={<LayoutGrid className="h-4 w-4" />}
              label="Kanban"
            />
          </div>
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" /> New lead
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-800">No leads yet</p>
          <p className="mt-1 text-sm text-gray-500">Enquiries from the connected email account appear here automatically. You can also add one by hand.</p>
          <Button className="mt-4" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" /> Add the first lead
          </Button>
        </div>
      ) : view === "kanban" ? (
        <LeadsKanban rows={rows} onStatusChange={setStatus} />
      ) : (
        <LeadsTable rows={rows} users={users} onPatch={patchLead} />
      )}

      <NewLeadDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        users={users}
        onCreated={() => {
          setNewOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function ViewTab({ href, active, icon, label }: { href: string; active: boolean; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium",
        active ? "bg-brand-600 text-white" : "text-gray-700 hover:bg-gray-100",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}
