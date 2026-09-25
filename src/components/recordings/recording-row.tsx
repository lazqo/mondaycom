"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Mic } from "lucide-react";
import { attachRecordingToContact, attachRecordingToLead, dismissRecording, restoreRecording } from "@/actions/recordings";
import { Badge, Button, FormError, Select } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export type RecordingRowData = {
  id: string;
  title: string;
  transcript: string;
  transcriptPolished: boolean;
  preview: string;
  recordedAt: Date | null;
  durationSeconds: number | null;
  status: "review" | "attached" | "dismissed";
  matchedBy: string | null;
  contact: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
};

function duration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export function RecordingRow({
  row,
  contacts,
  leads,
}: {
  row: RecordingRowData;
  contacts: { id: string; name: string; company: string | null }[];
  leads: { id: string; name: string; company: string | null }[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState("");

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error ?? "Something went wrong");
      router.refresh();
    });
  }

  function attach() {
    if (!target) return setError("Pick a customer or lead first");
    const [kind, id] = target.split(":");
    act(() => (kind === "lead" ? attachRecordingToLead(row.id, id) : attachRecordingToContact(row.id, id)));
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Mic className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-900">{row.title}</span>
            {row.status === "attached" && row.contact ? (
              <Link href={`/contacts/${row.contact.id}`} className="text-xs text-brand-700 hover:underline">
                {row.contact.name}
              </Link>
            ) : null}
            {row.status === "attached" && !row.contact && row.lead ? (
              <Link href={`/leads/${row.lead.id}`} className="text-xs text-brand-700 hover:underline">
                {row.lead.name}
              </Link>
            ) : null}
            {row.matchedBy ? <Badge className="bg-gray-100 text-gray-600">{row.matchedBy}</Badge> : null}
            <Badge className={row.transcriptPolished ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}>
              {row.transcriptPolished ? "Cleaned-up transcript" : "Original transcript"}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            {row.recordedAt ? formatDate(row.recordedAt) : "no date"}
            {row.durationSeconds ? ` · ${duration(row.durationSeconds)}` : ""} · {row.preview}
          </p>

          {row.status === "review" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select value={target} onChange={(e) => setTarget(e.target.value)} className="max-w-xs" aria-label="File this recording against">
                <option value="">File against…</option>
                {leads.length ? (
                  <optgroup label="Leads">
                    {leads.map((l) => (
                      <option key={l.id} value={`lead:${l.id}`}>
                        {l.name}
                        {l.company ? ` · ${l.company}` : ""}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {contacts.length ? (
                  <optgroup label="Customers">
                    {contacts.map((c) => (
                      <option key={c.id} value={`contact:${c.id}`}>
                        {c.name}
                        {c.company ? ` · ${c.company}` : ""}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </Select>
              <Button size="sm" disabled={pending} onClick={attach} data-testid={`attach-${row.id}`}>
                File it
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => dismissRecording(row.id))} data-testid={`dismiss-${row.id}`}>
                Not a customer
              </Button>
            </div>
          ) : null}

          {row.status === "dismissed" ? (
            <div className="mt-2">
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => restoreRecording(row.id))}>
                Put back in review
              </Button>
            </div>
          ) : null}

          <button type="button" onClick={() => setOpen((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-700">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {open ? "Hide transcript" : "Read transcript"}
          </button>
          {open ? (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 p-3 font-sans text-xs text-gray-800">
              {row.transcript}
            </pre>
          ) : null}
          <FormError message={error} />
        </div>
      </div>
    </div>
  );
}
