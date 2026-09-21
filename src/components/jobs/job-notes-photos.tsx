"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { addJobNote, addJobPhoto, deleteJobPhoto } from "@/actions/jobs";
import { Button, Card, CardHeader, FormError, Input, Textarea } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

type Note = { id: string; body: string; createdAt: Date; author: { id: string; name: string } | null };
type Photo = { id: string; filename: string; caption: string | null; createdAt: Date; contentType: string; size: number };

export function JobNotesPhotos({ jobId, notes, photos }: { jobId: string; notes: Note[]; photos: Photo[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const formRef = React.useRef<HTMLFormElement>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={`Notes (${notes.length})`} />
        <div className="space-y-3 p-4">
          <div className="space-y-2">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note about this job" className="min-h-16" aria-label="New note" />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={pending || !note.trim()}
                onClick={() =>
                  startTransition(async () => {
                    const res = await addJobNote(jobId, note);
                    if (!res.ok) return setError(res.error);
                    setNote("");
                    router.refresh();
                  })
                }
              >
                Add note
              </Button>
            </div>
          </div>
          {notes.length === 0 ? <p className="text-sm text-gray-500">No notes yet.</p> : null}
          <ul className="space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md bg-gray-50 px-3 py-2 text-sm">
                <p className="whitespace-pre-wrap text-gray-800">{n.body}</p>
                <p className="mt-1 text-xs text-gray-500">
                  {n.author?.name ?? "—"} · {formatDateTime(n.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </Card>
      <Card>
        <CardHeader title={`Photos (${photos.length})`} />
        <div className="space-y-3 p-4">
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              setError(null);
              startTransition(async () => {
                const res = await addJobPhoto(jobId, fd);
                if (!res.ok) return setError(res.error);
                formRef.current?.reset();
                router.refresh();
              });
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <Input name="photo" type="file" accept="image/*" required aria-label="Photo" className="h-auto py-1.5" />
            </div>
            <Input name="caption" placeholder="Caption (optional)" className="w-48" aria-label="Caption" />
            <Button type="submit" size="md" disabled={pending}>
              Upload
            </Button>
          </form>
          <FormError message={error} />
          {photos.length === 0 ? <p className="text-sm text-gray-500">No photos yet.</p> : null}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((p) => (
              <figure key={p.id} className="group relative">
                <a href={`/api/photos/${p.id}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/photos/${p.id}`} alt={p.caption ?? p.filename} className="aspect-square w-full rounded-md object-cover" />
                </a>
                <figcaption className="mt-1 truncate text-xs text-gray-500">{p.caption ?? p.filename}</figcaption>
                <button
                  type="button"
                  aria-label={`Delete ${p.filename}`}
                  onClick={() => {
                    if (!confirm("Delete this photo?")) return;
                    startTransition(async () => {
                      await deleteJobPhoto(p.id);
                      router.refresh();
                    });
                  }}
                  className="absolute right-1 top-1 hidden rounded bg-white/90 p-1 text-red-600 shadow group-hover:block"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </figure>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
