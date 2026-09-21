"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { syncMailboxNow } from "@/actions/mailboxes";
import { Button } from "@/components/ui";

export function SyncNowButton({ mailboxes }: { mailboxes: { id: string; emailAddress: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<string | null>(null);

  function run() {
    setMsg(null);
    startTransition(async () => {
      const parts: string[] = [];
      for (const m of mailboxes) {
        const res = await syncMailboxNow(m.id);
        parts.push(res.ok ? `${m.emailAddress}: ${res.data.stored} new, ${res.data.leads} leads, ${res.data.review} to review` : `${m.emailAddress}: ${res.error}`);
      }
      setMsg(parts.join(" · "));
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {msg ? <span className="max-w-md truncate text-xs text-gray-600" title={msg}>{msg}</span> : null}
      <Button variant="secondary" onClick={run} disabled={pending} data-testid="sync-now">
        <RefreshCw className={pending ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> {pending ? "Checking…" : "Check for new email"}
      </Button>
    </div>
  );
}
