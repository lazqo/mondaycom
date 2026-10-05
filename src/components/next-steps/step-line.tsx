"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { setTaskStatus } from "@/actions/tasks";
import { CommitmentButtons } from "@/components/inspector/controls";
import { dueLabel, type NextStep } from "@/lib/next-step";
import type { StepRecord } from "@/queries/next-steps";
import { cn } from "@/lib/utils";

/**
 * One next step, one line: what · why · when, the record it belongs to, and Done / Dismiss when
 * the step comes from a task or a promise. Derived steps (the checklist, a stage default) have
 * no buttons: they change when the record does.
 */
export function StepLine({ record, step, today, showRecord = true }: { record: StepRecord; step: NextStep; today: string; showRecord?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const task = step.source?.type === "task" ? step.source.id : null;
  const when = dueLabel(step, today);
  function set(id: string, status: "done" | "dismissed") {
    startTransition(async () => {
      await setTaskStatus(id, status);
      router.refresh();
    });
  }
  const testId = task ? `task-${task}` : `step-${record.type}-${record.id}`;
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-50" data-testid={testId} data-step={step.kind}>
      {task ? (
        <button type="button" onClick={() => set(task, "done")} disabled={pending} title="Mark done" aria-label={`Mark done: ${step.what}`} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gray-300 text-gray-400 hover:border-green-600 hover:text-green-600">
          <Check className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className={cn("h-2 w-2 shrink-0 rounded-full", step.overdue ? "bg-[#e2445c]" : step.waiting ? "bg-gray-300" : step.kind === "decision" ? "bg-[#a25ddc]" : "bg-[#00c875]")} aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-gray-900">
          {showRecord && record.label ? (
            <>
              {record.href ? (
                <Link href={record.href} className="font-medium hover:text-brand-700 hover:underline">
                  {record.label}
                </Link>
              ) : (
                <span className="font-medium">{record.label}</span>
              )}
              <span className="text-gray-400"> · </span>
            </>
          ) : null}
          <span className={cn(step.kind === "typed" ? "font-medium" : undefined)}>{step.what}</span>
        </p>
        <p className="truncate text-xs text-gray-500">
          {when ? <span className={step.overdue ? "font-medium text-red-600" : undefined}>{when}</span> : null}
          {when && step.why ? " · " : ""}
          {step.why}
        </p>
      </div>
      {task ? (
        <button type="button" onClick={() => set(task, "dismissed")} disabled={pending} title="Dismiss" aria-label={`Dismiss: ${step.what}`} className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : step.source?.type === "commitment" && !step.waiting ? (
        <CommitmentButtons id={step.source.id} />
      ) : null}
    </div>
  );
}

/** The step on its own record's page: no record name, the reason and the date in full. */
export function StepSummary({ step, today, testId }: { step: NextStep; today: string; testId?: string }) {
  const when = dueLabel(step, today);
  return (
    <p className="text-sm text-gray-700" data-testid={testId}>
      <span className="text-xs uppercase tracking-wide text-gray-500">Next step</span>{" "}
      <span className={cn("font-medium text-gray-900", step.overdue && "text-red-600")}>{step.what}</span>
      {when ? <span className={cn("text-gray-500", step.overdue && "font-medium text-red-600")}> · {when}</span> : null}
      {step.why ? <span className="text-gray-500"> · {step.why}</span> : null}
    </p>
  );
}
