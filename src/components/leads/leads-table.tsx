"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Mail } from "lucide-react";
import type { LeadRow } from "@/queries";
import { LEAD_STATUSES, LEAD_STATUS_META, type LeadStatus } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { DateCell, EditableText, PersonCell, SourceCell, StatusCell, type UserOption } from "./cells";
import type { LeadPatch } from "./leads-board";

const COLUMNS: { key: string; label: string; width: string }[] = [
  { key: "name", label: "Lead", width: "min-w-[170px]" },
  { key: "company", label: "Company", width: "min-w-[140px]" },
  { key: "phone", label: "Phone", width: "min-w-[120px]" },
  { key: "email", label: "Email", width: "min-w-[180px]" },
  { key: "service", label: "Service", width: "min-w-[130px]" },
  { key: "site", label: "Site", width: "min-w-[170px]" },
  { key: "status", label: "Status", width: "w-[130px] min-w-[130px]" },
  { key: "assignedToId", label: "Assigned To", width: "min-w-[130px]" },
  { key: "followUpAt", label: "Follow-up", width: "min-w-[135px]" },
  { key: "lastContactAt", label: "Last Contact", width: "min-w-[135px]" },
  { key: "source", label: "Source", width: "min-w-[110px]" },
];

export function LeadsTable({
  rows,
  users,
  onPatch,
}: {
  rows: LeadRow[];
  users: UserOption[];
  onPatch: (id: string, patch: LeadPatch) => void;
}) {
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const groups = LEAD_STATUSES.map((status) => ({
    status,
    rows: rows.filter((r) => r.status === status),
  }));

  return (
    <div className="board-grid space-y-5">
      {groups.map(({ status, rows: groupRows }) => {
        const meta = LEAD_STATUS_META[status];
        const isCollapsed = collapsed[status] ?? false;
        return (
          <section key={status} aria-label={`${meta.label} leads`}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [status]: !isCollapsed }))}
              className="mb-1 flex items-center gap-1.5 text-sm font-semibold"
              style={{ color: meta.color }}
            >
              {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {meta.label}
              <span className="ml-1 text-xs font-normal text-gray-500">
                {groupRows.length} {groupRows.length === 1 ? "lead" : "leads"}
              </span>
            </button>
            {!isCollapsed ? (
              <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs font-medium text-gray-500">
                      <th className="w-1.5 p-0" style={{ backgroundColor: meta.color }} />
                      {COLUMNS.map((c) => (
                        <th key={c.key} className={cn("border-l border-gray-200 px-2 py-2 text-left font-medium", c.width)}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.length === 0 ? (
                      <tr>
                        <td className="w-1.5 p-0" style={{ backgroundColor: meta.color }} />
                        <td colSpan={COLUMNS.length} className="px-3 py-3 text-sm text-gray-400">
                          No leads in {meta.label}
                        </td>
                      </tr>
                    ) : (
                      groupRows.map((r) => <LeadTableRow key={r.id} row={r} users={users} onPatch={onPatch} color={meta.color} />)
                    )}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function LeadTableRow({
  row,
  users,
  onPatch,
  color,
}: {
  row: LeadRow;
  users: UserOption[];
  onPatch: (id: string, patch: LeadPatch) => void;
  color: string;
}) {
  const p = (patch: LeadPatch) => onPatch(row.id, patch);
  return (
    <tr className="border-t border-gray-200 hover:bg-gray-50/60" data-testid={`lead-row-${row.id}`}>
      <td className="w-1.5 p-0" style={{ backgroundColor: color }} />
      <td className="border-l border-gray-200 p-0">
        <div className="flex items-center">
          <Link
            href={`/leads/${row.id}`}
            className="h-9 flex-1 truncate px-2 text-sm font-medium leading-9 text-gray-900 hover:text-brand-700 hover:underline"
            title="Open lead"
          >
            {row.name}
          </Link>
          {row.emailThreadId ? (
            <Link href={`/inbox/${row.emailThreadId}`} title="Open original email" className="mr-2 text-gray-400 hover:text-brand-700">
              <Mail className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      </td>
      <td className="border-l border-gray-200 p-0">
        <EditableText ariaLabel="Company" value={row.company} onCommit={(v) => p({ company: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <EditableText ariaLabel="Phone" type="tel" value={row.phone} onCommit={(v) => p({ phone: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <EditableText ariaLabel="Email" type="email" value={row.email} onCommit={(v) => p({ email: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <EditableText ariaLabel="Service" value={row.service} onCommit={(v) => p({ service: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <EditableText ariaLabel="Site" value={row.site} onCommit={(v) => p({ site: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <StatusCell value={row.status} onChange={(v: LeadStatus) => p({ status: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <PersonCell value={row.assignedToId} users={users} onChange={(v) => p({ assignedToId: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <DateCell ariaLabel="Follow-up" value={row.followUpAt} onChange={(v) => p({ followUpAt: v })} highlightOverdue />
      </td>
      <td className="border-l border-gray-200 p-0">
        <DateCell ariaLabel="Last contact" value={row.lastContactAt} onChange={(v) => p({ lastContactAt: v })} />
      </td>
      <td className="border-l border-gray-200 p-0">
        <SourceCell value={row.source} onChange={(v) => p({ source: v as LeadRow["source"] })} />
      </td>
    </tr>
  );
}
