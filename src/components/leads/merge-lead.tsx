"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { mergeLeadInto, searchLeads } from "@/actions/leads";
import { Button, Input } from "@/components/ui";
import { LEAD_STATUS_META } from "@/lib/constants";

type Found = Awaited<ReturnType<typeof searchLeads>>[number];

/** Merge this lead into another (a duplicate from a form and a call, say): everything moves across; this one is archived. */
export function MergeLead({ leadId, leadName }: { leadId: string; leadName: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [found, setFound] = React.useState<Found[]>([]);
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !q.trim()) return void setFound([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await searchLeads(q, leadId);
      if (!cancelled) setFound(r);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, q, leadId]);

  if (!open) {
    return (
      <button type="button" className="text-xs text-gray-500 hover:text-brand-700 hover:underline" onClick={() => setOpen(true)} data-testid="merge-open">
        Merge into another lead…
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm" data-testid="merge-lead">
      <p className="text-gray-700">
        Merge <span className="font-medium">{leadName}</span> into another lead: its emails, calls, tasks, promises and quotes move across, blanks on the other lead are filled from this one, and this one is archived.
      </p>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the lead to keep: name, phone, email or site" aria-label="Lead to merge into" data-testid="merge-search" />
      {found.length ? (
        <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
          {found.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium text-gray-900">{l.name}</span>
                <span className="ml-2 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: LEAD_STATUS_META[l.status].color }} />
                <span className="block truncate text-xs text-gray-500">{[l.phone, l.email, l.site].filter(Boolean).join(" · ") || "no details"}</span>
              </span>
              <Button
                size="sm"
                disabled={pending}
                data-testid={`merge-into-${l.id}`}
                onClick={() =>
                  startTransition(async () => {
                    setErr(null);
                    const res = await mergeLeadInto(leadId, l.id);
                    if (!res.ok) return setErr(res.error);
                    router.push(`/leads/${l.id}`);
                    router.refresh();
                  })
                }
              >
                Merge into this one
              </Button>
            </li>
          ))}
        </ul>
      ) : q.trim() ? (
        <p className="text-xs text-gray-500">No other open lead matches.</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        {err ? <span className="text-xs text-red-600">{err}</span> : null}
      </div>
    </div>
  );
}
