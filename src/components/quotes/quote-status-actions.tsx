"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { setQuoteStatus } from "@/actions/quotes";
import { Button } from "@/components/ui";
import type { QuoteStatus } from "@/lib/constants";

export function QuoteStatusActions({ quoteId, status, hasJob }: { quoteId: string; status: QuoteStatus; hasJob: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function go(next: QuoteStatus) {
    if (next === "accepted" && !hasJob && !confirm("Mark accepted? This will create a job for the customer.")) return;
    setError(null);
    startTransition(async () => {
      const res = await setQuoteStatus(quoteId, next);
      if (!res.ok) return setError(res.error);
      if (next === "accepted" && res.data.jobId) router.push(`/jobs/${res.data.jobId}`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {status === "draft" ? (
          <Button variant="secondary" onClick={() => go("sent")} disabled={pending}>
            Mark as sent
          </Button>
        ) : null}
        {status === "sent" ? (
          <>
            <Button variant="secondary" onClick={() => go("declined")} disabled={pending}>
              Declined
            </Button>
            <Button onClick={() => go("accepted")} disabled={pending}>
              Accepted
            </Button>
          </>
        ) : null}
        {status === "draft" ? (
          <Button onClick={() => go("accepted")} disabled={pending}>
            Accepted
          </Button>
        ) : null}
        {status === "declined" ? (
          <Button variant="secondary" onClick={() => go("draft")} disabled={pending}>
            Reopen as draft
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
