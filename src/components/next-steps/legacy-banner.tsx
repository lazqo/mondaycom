"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { replaceLegacyRemindersAction } from "@/actions/tasks";
import { Button } from "@/components/ui";
import type { LegacySummary } from "@/lib/automations/runner";

/** The reminders the old rules left open, summarised for Chris; nothing is closed until he clicks. */
export function LegacyRemindersBanner({ summary }: { summary: LegacySummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [done, setDone] = React.useState<number | null>(null);
  if (summary.total === 0) return null;
  return (
    <div className="rounded-md border border-[#ffcb00] bg-[#fff8db] px-4 py-3 text-sm text-gray-900" data-testid="legacy-reminders">
      <p className="font-medium">
        {summary.total} reminder{summary.total === 1 ? "" : "s"} from the old rules {summary.total === 1 ? "is" : "are"} still open.
      </p>
      <p className="mt-1 text-gray-700">
        Each lead and job now carries one next step instead (below), worked out from what has happened since. Nothing is closed until you say so: {summary.perRule.map((r) => `${r.count} “${r.name}”`).join(", ")}.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await replaceLegacyRemindersAction();
              if (r.ok) setDone(r.data.count);
              router.refresh();
            })
          }
        >
          Replace them with next steps
        </Button>
        {done !== null ? <span className="text-xs text-gray-600">{done} closed.</span> : null}
      </div>
    </div>
  );
}
