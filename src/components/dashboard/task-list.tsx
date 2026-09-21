"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import type { Task } from "@/db/schema";
import { setTaskStatus } from "@/actions/tasks";
import { formatDateOnly } from "@/lib/utils";

type Row = Task & { assignedTo?: { id: string; name: string } | null };

function linkFor(t: Task) {
  if (t.leadId) return `/leads/${t.leadId}`;
  if (t.jobId) return `/jobs/${t.jobId}`;
  if (t.quoteId) return `/quotes/${t.quoteId}`;
  if (t.contactId) return `/contacts/${t.contactId}`;
  return null;
}

export function TaskList({ tasks, showAssignee = true }: { tasks: Row[]; showAssignee?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  function set(id: string, status: "done" | "dismissed") {
    startTransition(async () => {
      await setTaskStatus(id, status);
      router.refresh();
    });
  }
  return (
    <>
      {tasks.map((t) => {
        const href = linkFor(t);
        return (
          <div key={t.id} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-50" data-testid={`task-${t.id}`}>
            <button type="button" onClick={() => set(t.id, "done")} disabled={pending} title="Mark done" aria-label={`Mark done: ${t.title}`} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gray-300 text-gray-400 hover:border-green-600 hover:text-green-600">
              <Check className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              {href ? (
                <Link href={href} className="block truncate font-medium text-gray-900 hover:text-brand-700 hover:underline">
                  {t.title}
                </Link>
              ) : (
                <p className="truncate font-medium text-gray-900">{t.title}</p>
              )}
              <p className="truncate text-xs text-gray-500">
                {t.dueAt ? `Due ${formatDateOnly(t.dueAt)}` : "No due date"}
                {showAssignee && t.assignedTo ? ` · ${t.assignedTo.name}` : ""}
                {t.detail ? ` · ${t.detail}` : ""}
                {t.ruleKey ? " · auto" : ""}
              </p>
            </div>
            <button type="button" onClick={() => set(t.id, "dismissed")} disabled={pending} title="Dismiss" aria-label={`Dismiss: ${t.title}`} className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </>
  );
}
