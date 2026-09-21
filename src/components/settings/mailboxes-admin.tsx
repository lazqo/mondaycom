"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { createMailbox, updateMailbox, deleteMailbox, testMailbox, syncMailboxNow } from "@/actions/mailboxes";
import { Badge, Button, Card, Dialog, Field, FormError, Input } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

export type MailboxView = {
  id: string;
  name: string;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  folder: string;
  active: boolean;
  lastUid: number;
  lastSyncAt: string | null;
  lastError: string | null;
};

const TITAN_DEFAULTS = { imapHost: "imap.titan.email", imapPort: 993, imapSecure: true, smtpHost: "smtp.titan.email", smtpPort: 465, smtpSecure: true, folder: "INBOX" };

export function MailboxesAdmin({ mailboxes }: { mailboxes: MailboxView[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<MailboxView | "new" | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<string | null>(null);

  function sync(m: MailboxView) {
    setMsg(null);
    startTransition(async () => {
      const res = await syncMailboxNow(m.id);
      setMsg(res.ok ? `${m.emailAddress}: fetched ${res.data.fetched}, stored ${res.data.stored}, leads ${res.data.leads}, review ${res.data.review}` : `${m.emailAddress}: ${res.error}`);
      router.refresh();
    });
  }
  function remove(m: MailboxView) {
    if (!confirm(`Remove ${m.emailAddress}? Stored emails for this mailbox will be deleted from the CRM.`)) return;
    startTransition(async () => {
      const res = await deleteMailbox(m.id);
      if (!res.ok) alert(res.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Mailboxes</h1>
          <p className="text-sm text-gray-500">Mailboxes the CRM reads enquiries from and replies through.</p>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> Connect mailbox
        </Button>
      </div>
      {msg ? <p className="text-sm text-gray-700">{msg}</p> : null}
      {mailboxes.length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">
          No mailbox yet. Titan needs <strong>third-party email access</strong> enabled for the account and, if two-factor is on, an <strong>app password</strong>. The
          defaults below are Titan&apos;s IMAP/SMTP servers.
        </Card>
      ) : (
        <div className="space-y-3">
          {mailboxes.map((m) => (
            <Card key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="mailbox-card">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
                  {m.name} <span className="text-gray-500">&lt;{m.emailAddress}&gt;</span>
                  <Badge className={m.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}>{m.active ? "Active" : "Paused"}</Badge>
                </p>
                <p className="text-xs text-gray-500">
                  {m.imapHost}:{m.imapPort} / {m.smtpHost}:{m.smtpPort} · folder {m.folder} · cursor UID {m.lastUid} · last sync {m.lastSyncAt ? formatDateTime(m.lastSyncAt) : "never"}
                </p>
                {m.lastError ? <p className="mt-1 text-xs text-red-600">Last error: {m.lastError}</p> : null}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => sync(m)} disabled={pending}>
                  Sync now
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditing(m)} disabled={pending}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => remove(m)} disabled={pending}>
                  Remove
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <MailboxDialog
        state={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function MailboxDialog({ state, onClose, onSaved }: { state: MailboxView | "new" | null; onClose: () => void; onSaved: () => void }) {
  const m = state && state !== "new" ? state : null;
  const [error, setError] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<{ imap: string; smtp: string } | null>(null);
  const [pending, startTransition] = React.useTransition();
  const formRef = React.useRef<HTMLFormElement>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = m ? await updateMailbox(m.id, fd) : await createMailbox(fd);
      if (!res.ok) return setError(res.error);
      onSaved();
    });
  }
  function test() {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    setError(null);
    setTestResult(null);
    startTransition(async () => {
      const res = await testMailbox(m?.id ?? null, fd);
      if (!res.ok) return setError(res.error);
      setTestResult(res.data);
    });
  }

  const d = m ?? { name: "", emailAddress: "", username: "", active: true, ...TITAN_DEFAULTS };
  return (
    <Dialog open={state !== null} onClose={onClose} title={m ? "Edit mailbox" : "Connect mailbox"} width="max-w-2xl">
      <form ref={formRef} key={m?.id ?? "new"} onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Display name *" htmlFor="mb-name">
            <Input id="mb-name" name="name" defaultValue={d.name} required placeholder="Sales inbox" />
          </Field>
          <Field label="Email address *" htmlFor="mb-email">
            <Input id="mb-email" name="emailAddress" type="email" defaultValue={d.emailAddress} required placeholder="info@getsecure.co.nz" />
          </Field>
          <Field label="Username *" htmlFor="mb-user">
            <Input id="mb-user" name="username" defaultValue={d.username} required placeholder="usually the full email address" />
          </Field>
          <Field label={m ? "Password (leave blank to keep)" : "Password / app password *"} htmlFor="mb-pass">
            <Input id="mb-pass" name="password" type="password" autoComplete="new-password" required={!m} />
          </Field>
          <Field label="IMAP host" htmlFor="mb-imap">
            <Input id="mb-imap" name="imapHost" defaultValue={d.imapHost} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="IMAP port" htmlFor="mb-imap-port">
              <Input id="mb-imap-port" name="imapPort" type="number" defaultValue={d.imapPort} required />
            </Field>
            <label className="mt-6 flex items-center gap-2 text-sm">
              <input type="checkbox" name="imapSecure" defaultChecked={d.imapSecure} /> SSL/TLS
            </label>
          </div>
          <Field label="SMTP host" htmlFor="mb-smtp">
            <Input id="mb-smtp" name="smtpHost" defaultValue={d.smtpHost} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SMTP port" htmlFor="mb-smtp-port">
              <Input id="mb-smtp-port" name="smtpPort" type="number" defaultValue={d.smtpPort} required />
            </Field>
            <label className="mt-6 flex items-center gap-2 text-sm">
              <input type="checkbox" name="smtpSecure" defaultChecked={d.smtpSecure} /> SSL/TLS
            </label>
          </div>
          <Field label="Folder to watch" htmlFor="mb-folder">
            <Input id="mb-folder" name="folder" defaultValue={d.folder} required />
          </Field>
          <label className="mt-6 flex items-center gap-2 text-sm">
            <input type="checkbox" name="active" defaultChecked={d.active} /> Active (ingest new mail)
          </label>
        </div>
        {testResult ? (
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700" data-testid="test-result">
            <p>IMAP: {testResult.imap}</p>
            <p>SMTP: {testResult.smtp}</p>
          </div>
        ) : null}
        <FormError message={error} />
        <div className="flex items-center justify-between">
          <Button type="button" variant="secondary" onClick={test} disabled={pending}>
            Test connection
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : m ? "Save" : "Connect"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
