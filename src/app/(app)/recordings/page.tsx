import type { Metadata } from "next";
import { desc, eq, inArray, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import { recordings, contacts, leads } from "@/db/schema";
import { requireOffice } from "@/lib/auth";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { RecordingRow, type RecordingRowData } from "@/components/recordings/recording-row";
import { SyncRecordingsButton } from "@/components/recordings/sync-button";
import { transcriptPreview } from "@/lib/recordings/match";
import { plaudConfigured } from "@/lib/recordings/plaud";

export const metadata: Metadata = { title: "Recordings" };
export const dynamic = "force-dynamic";

export default async function RecordingsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  await requireOffice();
  const { filter = "review" } = await searchParams;
  const status = filter === "attached" || filter === "dismissed" ? filter : "review";

  const [rows, contactRows, leadRows, counts] = await Promise.all([
    db.query.recordings.findMany({
      where: eq(recordings.status, status),
      orderBy: [desc(recordings.recordedAt), desc(recordings.createdAt)],
      limit: 50,
      with: { contact: { columns: { id: true, name: true } }, lead: { columns: { id: true, name: true } } },
    }),
    db.query.contacts.findMany({ columns: { id: true, name: true, company: true }, orderBy: [contacts.name], limit: 500 }),
    db.query.leads.findMany({
      where: and(isNull(leads.archivedAt), inArray(leads.status, ["new", "contacted", "site_visit", "quote_required", "quote_sent"])),
      columns: { id: true, name: true, company: true },
      orderBy: [desc(leads.createdAt)],
      limit: 200,
    }),
    db
      .select({ status: recordings.status })
      .from(recordings)
      .then((all) => ({
        review: all.filter((r) => r.status === "review").length,
        attached: all.filter((r) => r.status === "attached").length,
        dismissed: all.filter((r) => r.status === "dismissed").length,
      })),
  ]);

  const data: RecordingRowData[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    transcript: r.transcript,
    preview: transcriptPreview(r.transcript),
    recordedAt: r.recordedAt,
    durationSeconds: r.durationSeconds,
    status: r.status,
    matchedBy: r.matchedBy,
    contact: r.contact ?? null,
    lead: r.lead ?? null,
  }));

  const tabs = [
    { key: "review", label: "To file", count: counts.review },
    { key: "attached", label: "Filed", count: counts.attached },
    { key: "dismissed", label: "Not customers", count: counts.dismissed },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Recordings</h1>
          <p className="text-sm text-gray-500">
            Voice recordings from Plaud. Ones we can match to a customer file themselves; the rest wait here for you.
          </p>
        </div>
        <SyncRecordingsButton enabled={plaudConfigured()} />
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <a
            key={t.key}
            href={`/recordings?filter=${t.key}`}
            className={`rounded-md px-3 py-1.5 text-sm ${status === t.key ? "bg-brand-600 text-white" : "bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"}`}
          >
            {t.label} <span className={status === t.key ? "text-white/80" : "text-gray-400"}>{t.count}</span>
          </a>
        ))}
      </div>

      <Card data-testid="recordings-list">
        <CardHeader title={tabs.find((t) => t.key === status)!.label} />
        {data.length === 0 ? (
          <EmptyState
            title={status === "review" ? "Nothing to file" : status === "attached" ? "Nothing filed yet" : "Nothing here"}
            hint={
              !plaudConfigured()
                ? "Plaud is not switched on yet. Set PLAUD_ENABLED=true on the server."
                : status === "review"
                  ? "New recordings appear here when they cannot be matched to a customer automatically."
                  : undefined
            }
          />
        ) : (
          <div className="divide-y divide-gray-100">
            {data.map((r) => (
              <RecordingRow key={r.id} row={r} contacts={contactRows} leads={leadRows} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
