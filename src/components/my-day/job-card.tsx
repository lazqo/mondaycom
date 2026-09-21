"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MapPin, Phone, Camera, StickyNote } from "lucide-react";
import type { DayJob } from "@/queries/dashboard";
import { setJobStatus, addJobNote, addJobPhoto } from "@/actions/jobs";
import { Badge, Button, Card, FormError, Textarea } from "@/components/ui";
import { JOB_STATUS_META, type JobStatus } from "@/lib/constants";
import { cn } from "@/lib/utils";

const FLOW: JobStatus[] = ["scheduled", "en_route", "on_site", "done"];

function timeRange(s: Date, e: Date) {
  const f = (d: Date) => d.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" });
  return `${f(new Date(s))} – ${f(new Date(e))}`;
}

export function MyDayJobCard({ row }: { row: DayJob }) {
  const router = useRouter();
  const job = row.job!;
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement>(null);
  const idx = FLOW.indexOf(job.status);
  const next = idx >= 0 && idx < FLOW.length - 1 ? FLOW[idx + 1] : null;
  const meta = JOB_STATUS_META[job.status];
  const mapsHref = job.siteAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.siteAddress)}` : null;

  function go(status: JobStatus) {
    setError(null);
    startTransition(async () => {
      const res = await setJobStatus(job.id, status);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }
  function saveNote() {
    startTransition(async () => {
      const res = await addJobNote(job.id, note);
      if (!res.ok) return setError(res.error);
      setNote("");
      setNoteOpen(false);
      router.refresh();
    });
  }
  function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fd = new FormData();
    fd.append("photo", files[0]);
    startTransition(async () => {
      const res = await addJobPhoto(job.id, fd);
      if (!res.ok) return setError(res.error);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <Card className={cn("overflow-hidden", job.status === "done" || job.status === "invoiced" ? "opacity-70" : "")} data-testid={`myday-job-${job.id}`}>
      <div className="flex items-start justify-between gap-3 border-l-4 px-4 py-3" style={{ borderLeftColor: meta.color }}>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{timeRange(row.startsAt, row.endsAt)}</p>
          <Link href={`/jobs/${job.id}`} className="block truncate text-base font-medium text-gray-900 hover:underline">
            J-{job.number} · {job.title}
          </Link>
          <p className="truncate text-sm text-gray-600">
            {job.contact.name}
            {job.service ? ` · ${job.service}` : ""}
          </p>
        </div>
        <Badge className={`${meta.bg} ${meta.text} shrink-0`}>{meta.label}</Badge>
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-3 text-sm">
        {mapsHref ? (
          <a href={mapsHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-gray-800">
            <MapPin className="h-4 w-4" /> {job.siteAddress}
          </a>
        ) : (
          <span className="text-xs text-gray-400">No site address</span>
        )}
        {job.contact.phone ? (
          <a href={`tel:${job.contact.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-gray-800">
            <Phone className="h-4 w-4" /> {job.contact.phone}
          </a>
        ) : null}
      </div>
      {job.noteEntries.length || job.photos.length ? (
        <div className="space-y-2 border-t border-gray-100 px-4 py-2 text-sm">
          {job.noteEntries.slice(0, 3).map((n) => (
            <p key={n.id} className="text-gray-700">
              <span className="text-xs text-gray-400">{n.author?.name ?? "—"} · </span>
              {n.body}
            </p>
          ))}
          {job.photos.length ? (
            <div className="flex gap-2 overflow-x-auto">
              {job.photos.map((p) => (
                <a key={p.id} href={`/api/photos/${p.id}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- photos are served from our own DB route */}
                  <img src={`/api/photos/${p.id}`} alt={p.caption ?? p.filename} className="h-16 w-16 rounded object-cover" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-3">
        {next ? (
          <Button onClick={() => go(next)} disabled={pending} className="flex-1" data-testid="advance-status">
            {next === "en_route" ? "En route" : next === "on_site" ? "On site" : "Done"}
          </Button>
        ) : (
          <span className="text-xs text-gray-500">{job.status === "done" ? "Completed" : meta.label}</span>
        )}
        <Button variant="secondary" size="md" onClick={() => setNoteOpen((v) => !v)} aria-label="Add note">
          <StickyNote className="h-4 w-4" />
        </Button>
        <Button variant="secondary" size="md" onClick={() => fileRef.current?.click()} aria-label="Add photo" disabled={pending}>
          <Camera className="h-4 w-4" />
        </Button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => upload(e.target.files)} aria-label="Photo file" />
      </div>
      {noteOpen ? (
        <div className="space-y-2 border-t border-gray-100 px-4 py-3">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened on site?" className="min-h-20" autoFocus />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setNoteOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveNote} disabled={pending || !note.trim()}>
              Save note
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="px-4 pb-3">
          <FormError message={error} />
        </div>
      ) : null}
    </Card>
  );
}
