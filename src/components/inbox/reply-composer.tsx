"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { sendThreadReply } from "@/actions/inbox";
import { Button, Card, CardHeader, Field, FormError, Input, Textarea } from "@/components/ui";

export function ReplyComposer({
  threadId,
  inReplyToEmailId,
  defaultTo,
  defaultSubject,
}: {
  threadId: string;
  inReplyToEmailId: string | null;
  defaultTo: string;
  defaultSubject: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    setError(null);
    setSent(false);
    startTransition(async () => {
      const res = await sendThreadReply({ threadId, inReplyToEmailId, ...data });
      if (!res.ok) return setError(res.error);
      setSent(true);
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => setOpen(true)} data-testid="reply-open">
          <Send className="h-4 w-4" /> Reply
        </Button>
        {sent ? <span className="text-sm text-green-700">Reply sent.</span> : null}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader title="Reply" />
      <form onSubmit={submit} className="space-y-3 p-4">
        <Field label="To" htmlFor="rp-to">
          <Input id="rp-to" name="to" defaultValue={defaultTo} required />
        </Field>
        <Field label="Cc" htmlFor="rp-cc">
          <Input id="rp-cc" name="cc" placeholder="optional" />
        </Field>
        <Field label="Subject" htmlFor="rp-subject">
          <Input id="rp-subject" name="subject" defaultValue={defaultSubject} required />
        </Field>
        <Field label="Message" htmlFor="rp-text">
          <Textarea id="rp-text" name="text" className="min-h-40" required autoFocus placeholder="Write your reply. It is sent exactly as written; nothing is generated for you." />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending} data-testid="reply-send">
            {pending ? "Sending…" : "Send reply"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
