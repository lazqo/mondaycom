import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getThread, nextReviewThread } from "@/queries/email";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireOffice } from "@/lib/auth";
import { listActiveUsers } from "@/queries";
import { Badge } from "@/components/ui";
import { MessageCard } from "@/components/inbox/message-card";
import { ReviewPanel } from "@/components/inbox/review-panel";
import { ReplyComposer } from "@/components/inbox/reply-composer";
import { EMAIL_CLASSIFICATION_META, JOB_STATUS_META } from "@/lib/constants";
import { StatusPill } from "@/components/leads/cells";

export const metadata: Metadata = { title: "Email thread" };

export default async function ThreadPage({ params, searchParams }: { params: Promise<{ threadId: string }>; searchParams: Promise<{ created?: string }> }) {
  await requireOffice();
  const [{ threadId }, sp] = await Promise.all([params, searchParams]);
  const [thread, users, nextId] = await Promise.all([getThread(threadId), listActiveUsers(), nextReviewThread(threadId)]);
  if (!thread) notFound();
  const created = sp.created ? await db.query.leads.findFirst({ where: eq(leads.id, sp.created), columns: { id: true, name: true } }) : null;
  const inbound = thread.emails.filter((e) => e.direction === "inbound");
  const latestInbound = inbound[inbound.length - 1] ?? null;
  const reviewable = inbound.find((e) => e.classification === "needs_review" || e.classification === "error" || e.classification === "pending") ?? latestInbound;
  const lastMsg = thread.emails[thread.emails.length - 1];
  const replyTo = latestInbound ? [latestInbound.fromAddress, ...latestInbound.cc.map((c) => c.address).filter((a) => a !== thread.mailbox.emailAddress)] : [];

  const inReviewQueue = inbound.some((e) => e.classification === "needs_review" || e.classification === "error");
  return (
    <div className="space-y-4">
      {created ? (
        <div className="flex items-center justify-between rounded-md border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-900" data-testid="created-banner">
          <span>
            Lead created: <strong>{created.name}</strong>
          </span>
          <Link href={`/leads/${created.id}`} className="font-medium underline">
            Open lead →
          </Link>
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <Link href={inReviewQueue ? "/inbox?filter=needs_review" : "/inbox"} className="hover:text-brand-700">
              ← {inReviewQueue ? "Review queue" : "Inbox"}
            </Link>
            {nextId ? (
              <Link href={`/inbox/${nextId}`} className="hover:text-brand-700" data-testid="next-review">
                Next to review →
              </Link>
            ) : null}
          </div>
          <h1 className="mt-1 truncate text-xl font-semibold text-gray-900">{thread.subject || "(no subject)"}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
            <span>
              {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"} · {thread.mailbox.emailAddress}
            </span>
            {thread.lead ? (
              <Link href={`/leads/${thread.lead.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs hover:bg-gray-50">
                Lead: {thread.lead.name} <StatusPill value={thread.lead.status} />
              </Link>
            ) : null}
            {thread.contact ? (
              <Link href={`/contacts/${thread.contact.id}`} className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs hover:bg-gray-50">
                Customer: {thread.contact.name}
              </Link>
            ) : null}
            {thread.job ? (
              <Link href={`/jobs/${thread.job.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs hover:bg-gray-50">
                Job J-{thread.job.number}
                <Badge className={`${JOB_STATUS_META[thread.job.status].bg} ${JOB_STATUS_META[thread.job.status].text}`}>{JOB_STATUS_META[thread.job.status].label}</Badge>
              </Link>
            ) : null}
          </p>
        </div>
        {latestInbound ? (
          <Badge className={`${EMAIL_CLASSIFICATION_META[latestInbound.classification].bg} ${EMAIL_CLASSIFICATION_META[latestInbound.classification].text}`}>
            {EMAIL_CLASSIFICATION_META[latestInbound.classification].label}
          </Badge>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {thread.emails.map((e) => (
            <MessageCard key={e.id} email={e} mailboxAddress={thread.mailbox.emailAddress} />
          ))}
          <ReplyComposer
            threadId={thread.id}
            inReplyToEmailId={lastMsg?.id ?? null}
            defaultTo={replyTo.join(", ")}
            defaultSubject={thread.subject ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`) : "Re:"}
          />
        </div>
        <div>
          <ReviewPanel
            thread={{ id: thread.id, leadId: thread.lead?.id ?? null, contactId: thread.contact?.id ?? null, jobId: thread.job?.id ?? null }}
            email={reviewable ? { id: reviewable.id, classification: reviewable.classification, classificationError: reviewable.classificationError, fromName: reviewable.fromName, fromAddress: reviewable.fromAddress } : null}
            classification={reviewable?.classifications[0] ?? null}
            users={users}
            nextThreadId={nextId}
          />
        </div>
      </div>
    </div>
  );
}
