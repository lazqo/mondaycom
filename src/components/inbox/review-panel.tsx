"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { EmailClassificationRow } from "@/db/schema";
import { acceptEmailAsLead, rejectEmailAsLead, reclassifyEmail, linkThreadTo, unlinkThread, searchLinkTargets } from "@/actions/inbox";
import { Badge, Button, Card, CardHeader, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { EMAIL_CLASSIFICATION_META, LEAD_URGENCIES, LEAD_URGENCY_META, LEAD_STATUS_META, type EmailClassification } from "@/lib/constants";

type UserOption = { id: string; name: string };
type Targets = Awaited<ReturnType<typeof searchLinkTargets>>;

export function ReviewPanel({
  thread,
  email,
  classification,
  users,
}: {
  thread: { id: string; leadId: string | null; contactId: string | null; jobId: string | null };
  email: { id: string; classification: EmailClassification; classificationError: string | null; fromName: string | null; fromAddress: string } | null;
  classification: EmailClassificationRow | null;
  users: UserOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [targets, setTargets] = React.useState<Targets | null>(null);

  React.useEffect(() => {
    if (!linkOpen) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await searchLinkTargets(q);
      if (!cancelled) setTargets(r);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [linkOpen, q]);

  const x = classification?.result ?? null;
  const linked = thread.leadId || thread.contactId || thread.jobId;
  const canCreate = email && !thread.leadId && email.classification !== "outbound";

  function accept(form?: HTMLFormElement) {
    if (!email) return;
    const data = form ? Object.fromEntries(new FormData(form)) : {};
    setError(null);
    startTransition(async () => {
      const res = await acceptEmailAsLead(email.id, data);
      if (!res.ok) return setError(res.error);
      router.push(`/leads/${res.data.leadId}`);
      router.refresh();
    });
  }
  function reject() {
    if (!email) return;
    startTransition(async () => {
      const res = await rejectEmailAsLead(email.id);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }
  function reclassify() {
    if (!email) return;
    setError(null);
    startTransition(async () => {
      const res = await reclassifyEmail(email.id);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }
  function link(target: { leadId?: string; contactId?: string; jobId?: string }) {
    startTransition(async () => {
      const res = await linkThreadTo(thread.id, target);
      if (!res.ok) return setError(res.error);
      setLinkOpen(false);
      router.refresh();
    });
  }
  function unlink() {
    if (!confirm("Unlink this thread from its lead/customer/job?")) return;
    startTransition(async () => {
      const res = await unlinkThread(thread.id);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="AI assessment"
          action={
            email ? (
              <Button size="sm" variant="ghost" onClick={reclassify} disabled={pending}>
                Re-run
              </Button>
            ) : null
          }
        />
        <div className="space-y-3 p-4 text-sm">
          {email ? (
            <div className="flex items-center gap-2">
              <Badge className={`${EMAIL_CLASSIFICATION_META[email.classification].bg} ${EMAIL_CLASSIFICATION_META[email.classification].text}`}>
                {EMAIL_CLASSIFICATION_META[email.classification].label}
              </Badge>
              {classification ? (
                <span className="text-xs text-gray-500">
                  {classification.isLead ? "Lead" : "Not a lead"} · {Math.round(Number(classification.confidence) * 100)}% · {classification.provider}
                  {classification.model ? ` (${classification.model})` : ""}
                </span>
              ) : null}
            </div>
          ) : null}
          {email?.classificationError ? <FormError message={email.classificationError} /> : null}
          {x ? (
            <>
              <p className="text-gray-800">{x.summary}</p>
              <p className="text-xs text-gray-500">{x.reason}</p>
              <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-xs">
                <dt className="text-gray-500">Name</dt>
                <dd>{x.contact_name ?? "—"}</dd>
                <dt className="text-gray-500">Company</dt>
                <dd>{x.company ?? "—"}</dd>
                <dt className="text-gray-500">Email</dt>
                <dd>{x.email ?? "—"}</dd>
                <dt className="text-gray-500">Phone</dt>
                <dd>{x.phone ?? "—"}</dd>
                <dt className="text-gray-500">Service</dt>
                <dd>{x.service ?? "—"}</dd>
                <dt className="text-gray-500">Site</dt>
                <dd>{x.site_address ?? "—"}</dd>
                <dt className="text-gray-500">Urgency</dt>
                <dd>
                  <Badge className={`${LEAD_URGENCY_META[x.urgency].bg} ${LEAD_URGENCY_META[x.urgency].text}`}>{LEAD_URGENCY_META[x.urgency].label}</Badge>
                </dd>
                <dt className="text-gray-500">Next action</dt>
                <dd>{x.next_action}</dd>
              </dl>
            </>
          ) : email ? (
            <p className="text-gray-500">Not classified yet.</p>
          ) : (
            <p className="text-gray-500">No inbound message on this thread.</p>
          )}

          {canCreate ? (
            <div className="space-y-2 border-t border-gray-100 pt-3">
              {!editing ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => accept()} disabled={pending} data-testid="accept-lead">
                    Create lead
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={pending}>
                    Edit &amp; create
                  </Button>
                  {email.classification !== "not_lead" ? (
                    <Button size="sm" variant="ghost" onClick={reject} disabled={pending} data-testid="reject-lead">
                      Not a lead
                    </Button>
                  ) : null}
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    accept(e.currentTarget);
                  }}
                  className="space-y-2"
                >
                  <Field label="Name" htmlFor="rv-name">
                    <Input id="rv-name" name="contact_name" defaultValue={x?.contact_name ?? email.fromName ?? ""} />
                  </Field>
                  <Field label="Company" htmlFor="rv-company">
                    <Input id="rv-company" name="company" defaultValue={x?.company ?? ""} />
                  </Field>
                  <Field label="Email" htmlFor="rv-email">
                    <Input id="rv-email" name="email" defaultValue={x?.email ?? email.fromAddress} />
                  </Field>
                  <Field label="Phone" htmlFor="rv-phone">
                    <Input id="rv-phone" name="phone" defaultValue={x?.phone ?? ""} />
                  </Field>
                  <Field label="Service" htmlFor="rv-service">
                    <Input id="rv-service" name="service" defaultValue={x?.service ?? ""} />
                  </Field>
                  <Field label="Site address" htmlFor="rv-site">
                    <Input id="rv-site" name="site_address" defaultValue={x?.site_address ?? ""} />
                  </Field>
                  <Field label="Summary" htmlFor="rv-summary">
                    <Textarea id="rv-summary" name="summary" defaultValue={x?.summary ?? ""} className="min-h-16" />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Urgency" htmlFor="rv-urgency">
                      <Select id="rv-urgency" name="urgency" defaultValue={x?.urgency ?? "normal"}>
                        {LEAD_URGENCIES.map((u) => (
                          <option key={u} value={u}>
                            {LEAD_URGENCY_META[u].label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Assign to" htmlFor="rv-assign">
                      <Select id="rv-assign" name="assignedToId" defaultValue="">
                        <option value="">Unassigned</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Next action" htmlFor="rv-next">
                    <Input id="rv-next" name="next_action" defaultValue={x?.next_action ?? ""} />
                  </Field>
                  <div className="flex gap-2">
                    <Button size="sm" type="submit" disabled={pending}>
                      Create lead
                    </Button>
                    <Button size="sm" type="button" variant="secondary" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ) : null}
          <FormError message={error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Linked records"
          action={
            linked ? (
              <Button size="sm" variant="ghost" onClick={unlink} disabled={pending}>
                Unlink
              </Button>
            ) : null
          }
        />
        <div className="space-y-2 p-4 text-sm">
          {!linked ? <p className="text-gray-500">Not linked to a lead, customer or job.</p> : null}
          {!linkOpen ? (
            <Button size="sm" variant="secondary" onClick={() => setLinkOpen(true)}>
              Link to existing…
            </Button>
          ) : (
            <div className="space-y-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leads, customers, jobs…" autoFocus />
              <div className="max-h-64 space-y-2 overflow-y-auto text-xs">
                {targets?.leads.length ? (
                  <div>
                    <p className="mb-1 font-semibold text-gray-500">Leads</p>
                    {targets.leads.map((l) => (
                      <button key={l.id} type="button" onClick={() => link({ leadId: l.id })} className="flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-gray-100">
                        <span>
                          {l.name}
                          {l.company ? <span className="text-gray-500"> · {l.company}</span> : null}
                        </span>
                        <span className="rounded px-1.5 text-[10px] text-white" style={{ backgroundColor: LEAD_STATUS_META[l.status].color }}>
                          {LEAD_STATUS_META[l.status].label}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {targets?.contacts.length ? (
                  <div>
                    <p className="mb-1 font-semibold text-gray-500">Customers</p>
                    {targets.contacts.map((c) => (
                      <button key={c.id} type="button" onClick={() => link({ contactId: c.id })} className="block w-full rounded px-2 py-1 text-left hover:bg-gray-100">
                        {c.name}
                        {c.company ? <span className="text-gray-500"> · {c.company}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {targets?.jobs.length ? (
                  <div>
                    <p className="mb-1 font-semibold text-gray-500">Jobs</p>
                    {targets.jobs.map((j) => (
                      <button key={j.id} type="button" onClick={() => link({ jobId: j.id })} className="block w-full rounded px-2 py-1 text-left hover:bg-gray-100">
                        J-{j.number} · {j.title}
                      </button>
                    ))}
                  </div>
                ) : null}
                {targets && !targets.leads.length && !targets.contacts.length && !targets.jobs.length ? <p className="text-gray-500">No matches.</p> : null}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setLinkOpen(false)}>
                Close
              </Button>
            </div>
          )}
          {thread.leadId ? (
            <p>
              <Link href={`/leads/${thread.leadId}`} className="text-brand-700 hover:underline">
                Open lead →
              </Link>
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
