"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { saveRecordingProfileAction } from "@/actions/catalogue";
import { Badge, Button, Card, CardHeader, Field, FormError, Input, Select } from "@/components/ui";
import { KNOWLEDGE_STATUSES, KNOWLEDGE_STATUS_LABELS, type KnowledgeStatus, type RecordingRule } from "@/lib/brain/types";

export type ProfileView = {
  id: string;
  key: string;
  name: string;
  propertyType: string;
  isDefault: boolean;
  codec: string | null;
  frameRate: number | null;
  bitrateControl: string | null;
  recordingMode: string | null;
  retentionTargetDays: number | null;
  retentionMinimumDays: number | null;
  rules: RecordingRule[];
  version: number;
  status: KnowledgeStatus;
  notes: string | null;
  approvedBy: string | null;
  reviewedAt: string | null;
};

type RuleDraft = { id: string; scope: RecordingRule["scope"]; productId: string; family: string; minMp: string; maxMp: string; designBitrateMbps: string; codec: string; frameRate: string; note: string };

const str = (v: number | string | null | undefined) => (v == null ? "" : String(v));
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function toDraft(r: RecordingRule): RuleDraft {
  return {
    id: r.id,
    scope: r.scope,
    productId: r.productId ?? "",
    family: r.family ?? "",
    minMp: str(r.minMp),
    maxMp: str(r.maxMp),
    designBitrateMbps: str(r.designBitrateMbps),
    codec: r.codec ?? "",
    frameRate: str(r.frameRate),
    note: r.note ?? "",
  };
}

function ProfileForm({ p, canApprove, cameras }: { p: ProfileView; canApprove: boolean; cameras: { id: string; label: string }[] }) {
  const router = useRouter();
  const [v, setV] = React.useState({
    name: p.name,
    propertyType: p.propertyType,
    isDefault: p.isDefault,
    codec: p.codec ?? "",
    frameRate: str(p.frameRate),
    bitrateControl: p.bitrateControl ?? "",
    recordingMode: p.recordingMode ?? "",
    retentionTargetDays: str(p.retentionTargetDays),
    retentionMinimumDays: str(p.retentionMinimumDays),
    status: p.status,
    notes: p.notes ?? "",
  });
  const [rules, setRules] = React.useState<RuleDraft[]>(p.rules.map(toDraft));
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const set = (k: keyof typeof v, val: string | boolean) => setV((c) => ({ ...c, [k]: val }));
  const setRule = (i: number, k: keyof RuleDraft, val: string) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: val } : r)));
  const save = () =>
    start(async () => {
      setError(null);
      setMsg(null);
      const res = await saveRecordingProfileAction({
        id: p.id,
        key: p.key,
        name: v.name,
        propertyType: v.propertyType,
        isDefault: v.isDefault,
        codec: v.codec || null,
        frameRate: numOrNull(v.frameRate),
        bitrateControl: v.bitrateControl || null,
        recordingMode: v.recordingMode || null,
        retentionTargetDays: numOrNull(v.retentionTargetDays),
        retentionMinimumDays: numOrNull(v.retentionMinimumDays),
        rules: rules.map((r) => ({
          id: r.id,
          scope: r.scope,
          productId: r.scope === "product" ? r.productId || null : null,
          family: r.scope === "family" ? r.family || null : null,
          minMp: r.scope === "product" ? null : numOrNull(r.minMp),
          maxMp: r.scope === "product" ? null : numOrNull(r.maxMp),
          designBitrateMbps: numOrNull(r.designBitrateMbps),
          codec: r.codec || null,
          frameRate: numOrNull(r.frameRate),
          note: r.note || null,
        })),
        status: v.status,
        notes: v.notes || null,
      });
      if (!res.ok) return setError(res.error);
      setMsg("Saved.");
      router.refresh();
    });
  const id = p.id;
  return (
    <div className="space-y-3 border-t border-gray-100 p-4 text-sm" data-testid={`profile-${p.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-gray-900">
          {p.name} <span className="text-xs text-gray-500">{p.key} · v{p.version}</span>
        </p>
        <Badge className={p.status === "getsecure_approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>{KNOWLEDGE_STATUS_LABELS[p.status]}</Badge>
        {p.isDefault ? <Badge className="bg-gray-100 text-gray-700">default for {p.propertyType}</Badge> : null}
        {p.approvedBy ? <span className="text-xs text-gray-500">approved by {p.approvedBy}</span> : null}
        {p.reviewedAt ? <span className="text-xs text-gray-500">reviewed {p.reviewedAt}</span> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-5">
        <Field label="Name" htmlFor={`rp-n-${id}`}>
          <Input id={`rp-n-${id}`} value={v.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="For" htmlFor={`rp-t-${id}`}>
          <Select id={`rp-t-${id}`} value={v.propertyType} onChange={(e) => set("propertyType", e.target.value)}>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
            <option value="any">Any</option>
          </Select>
        </Field>
        <Field label="Codec" htmlFor={`rp-c-${id}`}>
          <Input id={`rp-c-${id}`} value={v.codec} onChange={(e) => set("codec", e.target.value)} placeholder="Not set" />
        </Field>
        <Field label="Frame rate (fps)" htmlFor={`rp-f-${id}`}>
          <Input id={`rp-f-${id}`} type="number" value={v.frameRate} onChange={(e) => set("frameRate", e.target.value)} placeholder="Not set" />
        </Field>
        <Field label="Bitrate control" htmlFor={`rp-b-${id}`}>
          <Select id={`rp-b-${id}`} value={v.bitrateControl} onChange={(e) => set("bitrateControl", e.target.value)}>
            <option value="">Not set</option>
            <option value="VBR">VBR</option>
            <option value="CBR">CBR</option>
          </Select>
        </Field>
        <Field label="Recording" htmlFor={`rp-m-${id}`}>
          <Select id={`rp-m-${id}`} value={v.recordingMode} onChange={(e) => set("recordingMode", e.target.value)}>
            <option value="">Not set</option>
            <option value="continuous">24/7 continuous</option>
            <option value="motion">Event / motion</option>
          </Select>
        </Field>
        <Field label="Retention target (days)" htmlFor={`rp-rt-${id}`}>
          <Input id={`rp-rt-${id}`} type="number" value={v.retentionTargetDays} onChange={(e) => set("retentionTargetDays", e.target.value)} placeholder="Not set" />
        </Field>
        <Field label="Retention minimum (days)" htmlFor={`rp-rm-${id}`}>
          <Input id={`rp-rm-${id}`} type="number" value={v.retentionMinimumDays} onChange={(e) => set("retentionMinimumDays", e.target.value)} placeholder="Not set" />
        </Field>
        <Field label="Status" htmlFor={`rp-s-${id}`}>
          <Select id={`rp-s-${id}`} value={v.status} onChange={(e) => set("status", e.target.value)}>
            {KNOWLEDGE_STATUSES.map((s) => (
              <option key={s} value={s} disabled={s === "getsecure_approved" && !canApprove}>
                {KNOWLEDGE_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 pt-5">
          <input type="checkbox" checked={v.isDefault} onChange={(e) => set("isDefault", e.target.checked)} /> Default for this property type
        </label>
      </div>

      <div className="rounded border border-gray-200">
        <p className="border-b border-gray-100 px-3 py-2 text-xs text-gray-600">
          Design bitrates. Most specific wins: a product rule, then a manufacturer/family rule, then a resolution band. The design bitrate is used for recorder bandwidth, storage
          and retention; a camera&apos;s published maximum only produces a warning.
        </p>
        {rules.length === 0 ? <p className="px-3 py-2 text-xs text-amber-700">No design bitrates yet: assessments will say an approved recording profile is required.</p> : null}
        {rules.map((r, i) => (
          <div key={r.id} className="grid grid-cols-2 items-center gap-2 border-t border-gray-100 px-3 py-2 text-xs sm:grid-cols-[8rem_16rem_5rem_5rem_6rem_6rem_5rem_1fr_auto]" data-testid="profile-rule">
            <Select value={r.scope} onChange={(e) => setRule(i, "scope", e.target.value)} className="h-8 text-xs" aria-label="Rule applies to">
              <option value="resolution">Resolution band</option>
              <option value="family">Manufacturer / family</option>
              <option value="product">Product</option>
            </Select>
            {r.scope === "product" ? (
              <Select value={r.productId} onChange={(e) => setRule(i, "productId", e.target.value)} className="h-8 text-xs" aria-label="Camera">
                <option value="">Choose camera…</option>
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            ) : r.scope === "family" ? (
              <Input value={r.family} onChange={(e) => setRule(i, "family", e.target.value)} placeholder="e.g. Hikvision" className="h-8 text-xs" aria-label="Brand/family" />
            ) : (
              <span className="text-gray-500">Any brand</span>
            )}
            <Input value={r.minMp} onChange={(e) => setRule(i, "minMp", e.target.value)} placeholder="from MP" className="h-8 text-xs" disabled={r.scope === "product"} aria-label="From MP" />
            <Input value={r.maxMp} onChange={(e) => setRule(i, "maxMp", e.target.value)} placeholder="to MP" className="h-8 text-xs" disabled={r.scope === "product"} aria-label="To MP" />
            <Input value={r.designBitrateMbps} onChange={(e) => setRule(i, "designBitrateMbps", e.target.value)} placeholder="Mbps" type="number" className="h-8 text-xs" aria-label="Design bitrate Mbps" />
            <Input value={r.codec} onChange={(e) => setRule(i, "codec", e.target.value)} placeholder="codec" className="h-8 text-xs" aria-label="Codec" />
            <Input value={r.frameRate} onChange={(e) => setRule(i, "frameRate", e.target.value)} placeholder="fps" type="number" className="h-8 text-xs" aria-label="Frame rate" />
            <Input value={r.note} onChange={(e) => setRule(i, "note", e.target.value)} placeholder="note" className="h-8 text-xs" aria-label="Note" />
            <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <div className="border-t border-gray-100 px-3 py-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setRules((rs) => [...rs, { id: `r${Date.now().toString(36)}`, scope: "resolution", productId: "", family: "", minMp: "", maxMp: "", designBitrateMbps: "", codec: "", frameRate: "", note: "" }])
            }
          >
            Add rule
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={v.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Notes" className="h-8 max-w-xl flex-1 text-xs" />
        <Button size="sm" onClick={save} disabled={pending}>
          Save profile (v{p.version + 1})
        </Button>
        {msg ? <span className="text-xs text-green-700">{msg}</span> : null}
        <FormError message={error} />
      </div>
    </div>
  );
}

export function ProfileSettings({ profiles, canApprove, cameras }: { profiles: ProfileView[]; canApprove: boolean; cameras: { id: string; label: string }[] }) {
  return (
    <Card>
      <CardHeader title="Recording profiles" />
      <p className="px-4 pt-2 text-xs text-gray-500">
        How cameras are configured to record. The design bitrate sets recorder bandwidth, hard-drive size and retention. Nothing here is filled in from datasheets: enter Get
        Secure&apos;s values and approve the profile.
      </p>
      {profiles.map((p) => (
        <ProfileForm key={p.id} p={p} canApprove={canApprove} cameras={cameras} />
      ))}
    </Card>
  );
}
