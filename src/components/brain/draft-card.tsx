"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  approveDraftAction,
  placeInTitanDraftsAction,
  rejectDraftAction,
  requestDraftRevisionAction,
  saveDraftAction,
  sendDraftAction,
  submitDraftAction,
} from "@/actions/approvals";
import { Badge, Button, Card, Field, FormError, Input, Textarea } from "@/components/ui";
import { DRAFT_STATUS_META, type DraftStatus } from "@/lib/constants";

export type DraftView = {
  id: string;
  status: DraftStatus;
  to: string;
  cc: string;
  subject: string;
  body: string;
  createdBy: string;
  createdAt: string;
  reviewNote: string | null;
  lead: { id: string; name: string } | null;
  inTitanDrafts: boolean;
  /** The proposal PDF attached to this email, and whether it is still the valid one. */
  attachment: { id: string; filename: string; current: boolean } | null;
};

export function DraftCard({ draft, canApprove }: { draft: DraftView; canApprove: boolean }) {
  const router = useRouter();
  const [to, setTo] = React.useState(draft.to);
  const [cc, setCc] = React.useState(draft.cc);
  const [subject, setSubject] = React.useState(draft.subject);
  const [body, setBody] = React.useState(draft.body);
  const [note, setNote] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const dirty = to !== draft.to || cc !== draft.cc || subject !== draft.subject || body !== draft.body;
  const meta = DRAFT_STATUS_META[draft.status];

  function act<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done?: (data: T) => string) {
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error);
      if (done) setMsg(done(res.data));
      router.refresh();
    });
  }

  return (
    <Card className="p-4" data-testid="draft-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="text-gray-700">
          Email {draft.lead ? (
            <>
              for{" "}
              <Link href={`/leads/${draft.lead.id}`} className="font-medium text-brand-700 hover:underline">
                {draft.lead.name}
              </Link>
            </>
          ) : null}
          <span className="text-gray-500">
            {" "}
            · prepared by {draft.createdBy} · {draft.createdAt}
          </span>
        </p>
        <span className="flex items-center gap-2">
          {draft.inTitanDrafts ? <Badge className="bg-gray-100 text-gray-700">In Titan Drafts</Badge> : null}
          <Badge className={`${meta.bg} ${meta.text}`}>{meta.label}</Badge>
        </span>
      </div>
      {draft.reviewNote ? <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">Review note: {draft.reviewNote}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="To" htmlFor={`to-${draft.id}`}>
          <Input id={`to-${draft.id}`} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Cc" htmlFor={`cc-${draft.id}`}>
          <Input id={`cc-${draft.id}`} value={cc} onChange={(e) => setCc(e.target.value)} />
        </Field>
        <Field label="Subject" htmlFor={`subj-${draft.id}`} className="sm:col-span-2">
          <Input id={`subj-${draft.id}`} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" htmlFor={`body-${draft.id}`} className="sm:col-span-2">
          <Textarea id={`body-${draft.id}`} value={body} onChange={(e) => setBody(e.target.value)} className="min-h-56 font-mono text-[13px]" />
        </Field>
      </div>
      {draft.attachment ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="draft-attachment">
          <span className="text-gray-500">Attachment:</span>
          <a href={`/api/quote-documents/${draft.attachment.id}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
            {draft.attachment.filename}
          </a>
          {draft.attachment.current ? (
            <Badge className="bg-green-100 text-green-800">Approved proposal</Badge>
          ) : (
            <Badge className="bg-red-100 text-red-800">No longer valid: the quote changed. It cannot be sent.</Badge>
          )}
        </p>
      ) : null}
      {dirty && draft.status === "approved" ? <p className="mt-1 text-xs text-amber-700">Saving changes takes the approval away; it will need approving again.</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {dirty ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => saveDraftAction(draft.id, { to, cc, subject, body }), () => "Saved.")}>
            Save changes
          </Button>
        ) : null}
        {draft.status === "draft" || draft.status === "revision_requested" ? (
          <Button size="sm" variant="secondary" disabled={pending || dirty} onClick={() => act(() => submitDraftAction(draft.id), () => "Submitted for review.")}>
            Submit for review
          </Button>
        ) : null}
        {canApprove && (draft.status === "ready_for_review" || draft.status === "draft") ? (
          <Button size="sm" disabled={pending || dirty} onClick={() => act(() => approveDraftAction(draft.id), () => "Approved.")} data-testid="approve-draft">
            Approve
          </Button>
        ) : null}
        {canApprove && draft.status === "approved" ? (
          <Button size="sm" disabled={pending || dirty} onClick={() => confirm(`Send this email to ${to}?`) && act(() => sendDraftAction(draft.id), () => "Sent.")} data-testid="send-draft">
            Send now
          </Button>
        ) : null}
        {draft.status === "ready_for_review" || draft.status === "approved" ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || dirty}
            onClick={() => act(() => placeInTitanDraftsAction(draft.id), (d) => `Placed in Titan ${d.folder}. Send it from Titan when ready; the CRM will notice.`)}
          >
            Put in Titan Drafts
          </Button>
        ) : null}
        {canApprove && draft.status !== "approved" ? (
          <>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for a revision or rejection" className="h-8 max-w-xs flex-1 text-xs" />
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => requestDraftRevisionAction(draft.id, note), () => "Sent back for revision.")}>
              Ask for revision
            </Button>
            <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" disabled={pending} onClick={() => act(() => rejectDraftAction(draft.id, note), () => "Rejected.")}>
              Reject
            </Button>
          </>
        ) : null}
        {!canApprove ? <span className="text-xs text-gray-500">Only Chris can approve or send.</span> : null}
      </div>
      {msg ? <p className="mt-2 text-sm text-green-700">{msg}</p> : null}
      <FormError message={error} />
    </Card>
  );
}
