"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { saveProposalSettingsAction } from "@/actions/proposals";
import { Button, Field, FormError, Input, Textarea } from "@/components/ui";
import type { ProposalSettings } from "@/lib/proposals/settings";

export function ProposalSettingsForm({ settings }: { settings: ProposalSettings }) {
  const router = useRouter();
  const [v, setV] = React.useState({ ...settings, validityDays: settings.validityDays == null ? "" : String(settings.validityDays) });
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((cur) => ({ ...cur, [k]: e.target.value }));

  function save() {
    setError(null);
    setMsg(null);
    start(async () => {
      const r = await saveProposalSettingsAction({ ...v, validityDays: v.validityDays.trim() ? Number(v.validityDays) : null });
      if (!r.ok) return setError(r.error);
      setMsg("Saved. New proposals use it; PDFs already made are unchanged.");
      router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2" data-testid="proposal-settings">
      <Field label="Name customers see (trading name)" htmlFor="ps-name" hint="Printed prominently on every proposal">
        <Input id="ps-name" value={v.companyName} onChange={set("companyName")} />
      </Field>
      <Field label="Legal entity (optional)" htmlFor="ps-legal" hint="Printed small in the footer: “… is a trading name of …”">
        <Input id="ps-legal" value={v.legalName} onChange={set("legalName")} />
      </Field>
      <Field label="Phone" htmlFor="ps-phone">
        <Input id="ps-phone" value={v.phone} onChange={set("phone")} />
      </Field>
      <Field label="Email" htmlFor="ps-email">
        <Input id="ps-email" value={v.email} onChange={set("email")} />
      </Field>
      <Field label="Website" htmlFor="ps-web">
        <Input id="ps-web" value={v.website} onChange={set("website")} />
      </Field>
      <Field label="Address (optional)" htmlFor="ps-addr">
        <Input id="ps-addr" value={v.address} onChange={set("address")} />
      </Field>
      <Field label="GST number (optional)" htmlFor="ps-gst">
        <Input id="ps-gst" value={v.gstNumber} onChange={set("gstNumber")} />
      </Field>
      <Field label="Standard validity (days)" htmlFor="ps-valid" hint="Each quote can override or remove it. Blank: no validity date by default">
        <Input id="ps-valid" type="number" min={1} max={365} value={v.validityDays} onChange={set("validityDays")} />
      </Field>
      <Field label="Installation includes (one point per line)" htmlFor="ps-inst" className="sm:col-span-2">
        <Textarea id="ps-inst" value={v.installationIncludes} onChange={set("installationIncludes")} className="min-h-20" />
      </Field>
      <Field label="Warranty and support (one point per line; blank omits it)" htmlFor="ps-warranty" className="sm:col-span-2">
        <Textarea id="ps-warranty" value={v.warranty} onChange={set("warranty")} className="min-h-24" />
      </Field>
      <Field label="Next steps (blank omits it)" htmlFor="ps-next" className="sm:col-span-2">
        <Textarea id="ps-next" value={v.nextSteps} onChange={set("nextSteps")} className="min-h-16" />
      </Field>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button size="sm" onClick={save} disabled={pending} data-testid="save-proposal-settings">
          Save
        </Button>
        {msg ? <span className="text-xs text-green-700">{msg}</span> : null}
      </div>
      <div className="sm:col-span-2">
        <FormError message={error} />
      </div>
    </div>
  );
}
