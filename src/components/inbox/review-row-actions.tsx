"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { acceptEmailAsLead, rejectEmailAsLead } from "@/actions/inbox";
import { Button } from "@/components/ui";

/** One-click decisions straight from the review list. */
export function ReviewRowActions({ emailId }: { emailId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        disabled={pending}
        data-testid={`row-accept-${emailId}`}
        onClick={() =>
          startTransition(async () => {
            const res = await acceptEmailAsLead(emailId, {});
            if (!res.ok) return setErr(res.error);
            router.refresh();
          })
        }
      >
        Lead
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        data-testid={`row-reject-${emailId}`}
        onClick={() =>
          startTransition(async () => {
            const res = await rejectEmailAsLead(emailId);
            if (!res.ok) return setErr(res.error);
            router.refresh();
          })
        }
      >
        Not a lead
      </Button>
      {err ? <span className="text-xs text-red-600">{err}</span> : null}
    </div>
  );
}
