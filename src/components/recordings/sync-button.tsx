"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { syncRecordingsNow } from "@/actions/recordings";
import { Button, FormError } from "@/components/ui";

export function SyncRecordingsButton({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  return (
    <div className="text-right">
      <Button
        variant="secondary"
        disabled={pending || !enabled}
        title={enabled ? undefined : "Set PLAUD_ENABLED=true on the server"}
        onClick={() => {
          setError(null);
          setNote(null);
          startTransition(async () => {
            const res = await syncRecordingsNow();
            if (!res.ok) return setError(res.error);
            setNote(res.data.imported === 0 ? "Nothing new." : `${res.data.imported} new · ${res.data.attached} filed · ${res.data.review} to review`);
            router.refresh();
          });
        }}
      >
        <RefreshCw className={pending ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Check for new recordings
      </Button>
      {note ? <p className="mt-1 text-xs text-gray-500">{note}</p> : null}
      <FormError message={error} />
    </div>
  );
}
