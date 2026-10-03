"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { saveKitAction } from "@/actions/catalogue";
import { Badge, Button, Card, CardHeader, Field, FormError, Input, Select } from "@/components/ui";
import { KNOWLEDGE_STATUSES, KNOWLEDGE_STATUS_LABELS, TIERS, type KnowledgeStatus } from "@/lib/brain/types";

export type KitView = {
  id: string;
  key: string | null;
  name: string;
  propertyType: "residential" | "commercial" | "both";
  tier: string | null;
  cameraCount: number;
  cameraProductId: string;
  nvrProductId: string;
  defaultHddTb: number | null;
  defaultHddProductId: string | null;
  accessories: { productId: string; quantity: number; perCamera: boolean }[];
  status: KnowledgeStatus;
  version: number;
  notes: string | null;
  approvedBy: string | null;
};

export type KitProductOption = { id: string; label: string; category: string; capacityTb?: number | null };

/** Capacities offered for a kit's default HDD: the usual sizes plus any capacity in the catalogue. */
const STANDARD_TB = [1, 2, 4, 6, 8];

function KitForm({ kit, products, canApprove, onDone }: { kit: KitView | null; products: KitProductOption[]; canApprove: boolean; onDone?: () => void }) {
  const router = useRouter();
  const [v, setV] = React.useState({
    key: kit?.key ?? "",
    name: kit?.name ?? "",
    propertyType: kit?.propertyType ?? "residential",
    tier: kit?.tier ?? "good",
    cameraCount: String(kit?.cameraCount ?? 4),
    cameraProductId: kit?.cameraProductId ?? "",
    nvrProductId: kit?.nvrProductId ?? "",
    hdd: kit?.defaultHddProductId ? `id:${kit.defaultHddProductId}` : kit?.defaultHddTb ? `cap:${kit.defaultHddTb}` : "",
    status: (kit?.status ?? "requires_review") as KnowledgeStatus,
    notes: kit?.notes ?? "",
  });
  const [acc, setAcc] = React.useState(kit?.accessories ?? []);
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const set = (k: keyof typeof v, val: string) => setV((cur) => ({ ...cur, [k]: val }));
  const id = kit?.id ?? "new";
  const of = (c: string) => products.filter((p) => p.category === c);
  const capacities = [...new Set([...STANDARD_TB, ...of("hdd").map((d) => d.capacityTb ?? 0).filter((x) => x > 0)])].sort((a, b) => a - b);
  const accessoryOptions = products.filter((p) => !["camera", "nvr", "hdd", "kit"].includes(p.category));

  function save() {
    setError(null);
    setMsg(null);
    start(async () => {
      const r = await saveKitAction({
        id: kit?.id ?? null,
        key: v.key || null,
        name: v.name,
        propertyType: v.propertyType,
        tier: v.propertyType === "commercial" || v.tier === "" ? null : v.tier,
        cameraCount: Number(v.cameraCount),
        cameraProductId: v.cameraProductId,
        nvrProductId: v.nvrProductId,
        defaultHddTb: v.hdd.startsWith("cap:") ? Number(v.hdd.slice(4)) : null,
        defaultHddProductId: v.hdd.startsWith("id:") ? v.hdd.slice(3) : null,
        accessories: acc,
        status: v.status,
        notes: v.notes || null,
      });
      if (!r.ok) return setError(r.error);
      setMsg("Saved.");
      onDone?.();
      router.refresh();
    });
  }

  return (
    <div className="grid gap-2 border-t border-gray-100 p-4 text-sm sm:grid-cols-4" data-testid="kit-form">
      <Field label="Key" htmlFor={`kk-${id}`} hint="e.g. VIGI_GOOD_4">
        <Input id={`kk-${id}`} value={v.key} onChange={(e) => set("key", e.target.value.toUpperCase())} />
      </Field>
      <Field label="Name" htmlFor={`kn-${id}`} className="sm:col-span-2">
        <Input id={`kn-${id}`} value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="VIGI Good, 4 cameras" />
      </Field>
      <Field label="Status" htmlFor={`ks-${id}`}>
        <Select id={`ks-${id}`} value={v.status} onChange={(e) => set("status", e.target.value)}>
          {KNOWLEDGE_STATUSES.map((s) => (
            <option key={s} value={s} disabled={s === "getsecure_approved" && !canApprove}>
              {KNOWLEDGE_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Market" htmlFor={`km-${id}`}>
        <Select id={`km-${id}`} value={v.propertyType} onChange={(e) => set("propertyType", e.target.value)}>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
          <option value="both">Both</option>
        </Select>
      </Field>
      {v.propertyType !== "commercial" ? (
        <Field label="Tier" htmlFor={`kt-${id}`}>
          <Select id={`kt-${id}`} value={v.tier} onChange={(e) => set("tier", e.target.value)}>
            <option value="">Any tier</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Exact camera count" htmlFor={`kc-${id}`}>
        <Input id={`kc-${id}`} type="number" min={1} value={v.cameraCount} onChange={(e) => set("cameraCount", e.target.value)} />
      </Field>
      <Field label="Camera" htmlFor={`kcam-${id}`} className="sm:col-span-2">
        <Select id={`kcam-${id}`} value={v.cameraProductId} onChange={(e) => set("cameraProductId", e.target.value)}>
          <option value="">Choose camera…</option>
          {of("camera").map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Recorder" htmlFor={`knvr-${id}`} className="sm:col-span-2">
        <Select id={`knvr-${id}`} value={v.nvrProductId} onChange={(e) => set("nvrProductId", e.target.value)}>
          <option value="">Choose recorder…</option>
          {of("nvr").map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Default HDD" htmlFor={`khdd-${id}`} className="sm:col-span-2" hint="Used for every quote with this kit unless Chris overrides it on the assessment">
        <Select id={`khdd-${id}`} value={v.hdd} onChange={(e) => set("hdd", e.target.value)}>
          <option value="">No default (fallback rule / choose per quote)</option>
          <optgroup label="Capacity (the approved drive of that size)">
            {capacities.map((tb) => (
              <option key={tb} value={`cap:${tb}`}>
                {tb} TB
              </option>
            ))}
          </optgroup>
          <optgroup label="Specific drive">
            {of("hdd").map((p) => (
              <option key={p.id} value={`id:${p.id}`}>
                {p.label}
              </option>
            ))}
          </optgroup>
        </Select>
      </Field>
      <div className="space-y-1 sm:col-span-4">
        <p className="text-xs font-semibold text-gray-700">Accessories (charged with the kit)</p>
        {acc.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
            <Select value={a.productId} onChange={(e) => setAcc((cur) => cur.map((x, n) => (n === i ? { ...x, productId: e.target.value } : x)))} className="h-8 w-72 text-xs" aria-label="Accessory">
              {accessoryOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Input type="number" min={1} value={a.quantity} onChange={(e) => setAcc((cur) => cur.map((x, n) => (n === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x)))} className="h-8 w-16 text-xs" aria-label="Quantity" />
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={a.perCamera} onChange={(e) => setAcc((cur) => cur.map((x, n) => (n === i ? { ...x, perCamera: e.target.checked } : x)))} /> per camera
            </label>
            <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setAcc((cur) => cur.filter((_, n) => n !== i))}>
              Remove
            </Button>
          </div>
        ))}
        {accessoryOptions.length ? (
          <Button size="sm" variant="ghost" onClick={() => setAcc((cur) => [...cur, { productId: accessoryOptions[0].id, quantity: 1, perCamera: true }])}>
            Add accessory
          </Button>
        ) : null}
      </div>
      <Field label="Notes" htmlFor={`knotes-${id}`} className="sm:col-span-3">
        <Input id={`knotes-${id}`} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <div className="flex items-end gap-2">
        <Button size="sm" variant="secondary" disabled={pending || !v.name || !v.cameraProductId || !v.nvrProductId} onClick={save} data-testid="save-kit">
          {kit ? "Save kit" : "Add kit"}
        </Button>
        {msg ? <span className="text-xs text-green-700">{msg}</span> : null}
      </div>
      <FormError message={error} />
    </div>
  );
}

export function KitSettings({ kits, products, canApprove }: { kits: KitView[]; products: KitProductOption[]; canApprove: boolean }) {
  const [adding, setAdding] = React.useState(false);
  const label = new Map(products.map((p) => [p.id, p.label]));
  return (
    <Card>
      <CardHeader
        title={`Approved kits · ${kits.length}`}
        action={
          <Button size="sm" variant="secondary" onClick={() => setAdding((x) => !x)} data-testid="add-kit">
            {adding ? "Close" : "Add kit"}
          </Button>
        }
      />
      <p className="px-4 pt-2 text-xs text-gray-500">
        A kit is Get Secure&apos;s standard system for an exact camera count: cameras + recorder + default HDD + accessories. An approved kit is used automatically for
        matching jobs; the HDD is the kit&apos;s default unless Chris chooses another on the assessment. The installation package is separate.
      </p>
      {adding ? <KitForm kit={null} products={products} canApprove={canApprove} onDone={() => setAdding(false)} /> : null}
      {kits.length === 0 && !adding ? <p className="px-4 py-6 text-sm text-gray-500">No kits yet. Without one, products are chosen from the catalogue and the HDD from the fallback rule.</p> : null}
      {kits.map((k) => (
        <details key={k.id} className="border-t border-gray-100" data-testid="kit-row">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <span className="font-medium text-gray-900">{k.name}</span>
            {k.key ? <span className="text-xs text-gray-500">{k.key}</span> : null}
            <span className="text-xs text-gray-600">
              {k.cameraCount} × {label.get(k.cameraProductId) ?? "?"} · {label.get(k.nvrProductId) ?? "?"} · HDD{" "}
              {k.defaultHddProductId ? (label.get(k.defaultHddProductId) ?? "?") : k.defaultHddTb ? `${k.defaultHddTb} TB` : "not set"}
              {k.accessories.length ? ` · ${k.accessories.length} accessor${k.accessories.length === 1 ? "y" : "ies"}` : ""}
            </span>
            <Badge className={k.status === "getsecure_approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>{KNOWLEDGE_STATUS_LABELS[k.status]}</Badge>
          </summary>
          <KitForm kit={k} products={products} canApprove={canApprove} />
        </details>
      ))}
    </Card>
  );
}
