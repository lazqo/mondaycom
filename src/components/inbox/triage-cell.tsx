"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { acceptInspectorAction } from "@/actions/inspector";
import { Badge, Button } from "@/components/ui";
import { CATEGORY_META, type Triage } from "@/lib/inbox/categories";
import { cn } from "@/lib/utils";
import { ReviewRowActions } from "./review-row-actions";

/** What the email is and the state of play, with the one click it waits on. */
export function TriageCell({ triage, compact = false }: { triage: Triage; compact?: boolean }) {
  const meta = CATEGORY_META[triage.category];
  return (
    <div className="min-w-0" data-testid="triage" data-tone={triage.tone} data-category={triage.category}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className={`${meta.bg} ${meta.text}`}>{meta.label}</Badge>
        <span className={cn("text-sm", triage.tone === "attention" ? "font-medium text-gray-900" : triage.tone === "quiet" ? "text-gray-500" : "text-gray-800")} data-testid="triage-headline">
          {triage.headline}
        </span>
      </div>
      {!compact && triage.detail ? <p className="mt-0.5 truncate text-xs text-gray-500">{triage.detail}</p> : null}
    </div>
  );
}

/** The one click: decide the review, accept the proposal, or go to the card on Home. */
export function TriageAction({ emailId, triage }: { emailId: string; triage: Triage }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  if (triage.needsReview) return <ReviewRowActions emailId={emailId} />;
  if (triage.decision) {
    const d = triage.decision;
    if (d.direct) {
      return (
        <span className="inline-flex items-center gap-1">
          <Button
            size="sm"
            disabled={pending}
            data-testid={`row-decide-${emailId}`}
            onClick={() =>
              startTransition(async () => {
                const res = await acceptInspectorAction(d.actionId);
                if (!res.ok) return setErr(res.error);
                router.refresh();
              })
            }
          >
            {d.label.replace(/^./, (c) => c.toUpperCase())}
          </Button>
          {err ? <span className="text-xs text-red-600">{err}</span> : null}
        </span>
      );
    }
    return (
      <Link href="/dashboard" className="text-sm text-brand-700 hover:underline" data-testid={`row-decide-${emailId}`}>
        Decide on Home →
      </Link>
    );
  }
  if (triage.question) {
    return (
      <Link href="/dashboard" className="text-sm text-brand-700 hover:underline">
        Answer on Home →
      </Link>
    );
  }
  return null;
}
