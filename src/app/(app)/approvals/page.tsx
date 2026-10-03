import type { Metadata } from "next";
import Link from "next/link";
import { desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { drafts, quoteDocuments, quotes } from "@/db/schema";
import { documentIsCurrent } from "@/lib/proposals/workflow";
import { requireOffice } from "@/lib/auth";
import { Badge, Card, CardHeader } from "@/components/ui";
import { DraftCard } from "@/components/brain/draft-card";
import { QUOTE_STATUS_META } from "@/lib/constants";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const user = await requireOffice();
  const [openDrafts, openQuotes] = await Promise.all([
    db.query.drafts.findMany({
      where: inArray(drafts.status, ["ready_for_review", "approved", "revision_requested", "draft"]),
      with: { lead: { columns: { id: true, name: true } } },
      orderBy: [desc(drafts.updatedAt)],
      limit: 50,
    }),
    db.query.quotes.findMany({
      where: inArray(quotes.status, ["ai_prepared", "needs_review", "approved"]),
      with: { lead: { columns: { id: true, name: true } }, contact: { columns: { name: true } } },
      orderBy: [desc(quotes.updatedAt)],
      limit: 50,
    }),
  ]);
  const docIds = [...new Set(openDrafts.map((d) => d.quoteDocumentId).filter(Boolean) as string[])];
  const docs = docIds.length
    ? await db.query.quoteDocuments.findMany({ where: inArray(quoteDocuments.id, docIds), columns: { id: true, quoteId: true, filename: true, voidedAt: true, approvalHash: true }, with: { quote: true } })
    : [];
  const attachment = (id: string | null) => {
    const doc = docs.find((x) => x.id === id);
    return doc ? { id: doc.id, filename: doc.filename, current: documentIsCurrent(doc, doc.quote) } : null;
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Approvals</h1>
        <p className="text-sm text-gray-500">
          Everything prepared for a customer waits here. Nothing reaches a customer until {user.canApprove ? "you approve and send it" : "Chris approves it"}.
        </p>
      </div>

      <Card>
        <CardHeader title={`Quotes to review · ${openQuotes.length}`} />
        {openQuotes.length === 0 ? <p className="px-4 py-4 text-sm text-gray-500">No quotes waiting.</p> : null}
        <div className="divide-y divide-gray-100">
          {openQuotes.map((q) => (
            <Link key={q.id} href={`/quotes/${q.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50" data-testid="approval-quote">
              <span>
                <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title}
                <span className="text-gray-500"> · {q.contact?.name ?? q.lead?.name ?? "—"}</span>
              </span>
              <span className="flex items-center gap-3">
                <span>{formatMoney(q.total)}</span>
                <Badge className={`${QUOTE_STATUS_META[q.status].bg} ${QUOTE_STATUS_META[q.status].text}`}>{QUOTE_STATUS_META[q.status].label}</Badge>
              </span>
            </Link>
          ))}
        </div>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">Emails to review · {openDrafts.length}</h2>
        {openDrafts.length === 0 ? <p className="text-sm text-gray-500">No email drafts waiting.</p> : null}
        {openDrafts.map((d) => (
          <DraftCard
            key={d.id}
            canApprove={!!user.canApprove}
            draft={{
              id: d.id,
              status: d.status,
              to: d.toAddresses.join(", "),
              cc: d.ccAddresses.join(", "),
              subject: d.subject,
              body: d.body,
              createdBy: d.createdByActor === "user" ? "staff" : d.createdByActor.replace(/^agent:/, "").replace(/^system:/, "system: "),
              createdAt: formatDateTime(d.createdAt),
              reviewNote: d.reviewNote,
              lead: d.lead,
              inTitanDrafts: !!d.mailboxDraftMessageId,
              attachment: attachment(d.quoteDocumentId),
            }}
          />
        ))}
      </div>
    </div>
  );
}
