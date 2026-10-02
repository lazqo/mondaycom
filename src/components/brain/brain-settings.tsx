"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  approvePriceAction,
  recordPriceAction,
  savePackageAction,
  savePolicyAction,
  saveProductAction,
  saveSupplierAction,
  setSupplierCredentialAction,
} from "@/actions/catalogue";
import { Badge, Button, Card, CardHeader, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { KNOWLEDGE_STATUSES, KNOWLEDGE_STATUS_LABELS, TIERS, type KnowledgeStatus } from "@/lib/brain/types";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<KnowledgeStatus, string> = {
  industry_fact: "bg-sky-100 text-sky-800",
  manufacturer_verified: "bg-sky-100 text-sky-800",
  getsecure_approved: "bg-green-100 text-green-800",
  getsecure_provisional: "bg-amber-100 text-amber-800",
  historical_reference: "bg-gray-100 text-gray-700",
  requires_review: "bg-red-100 text-red-800",
  deprecated: "bg-gray-200 text-gray-500",
};

export function StatusBadge({ status }: { status: KnowledgeStatus }) {
  return <Badge className={STATUS_STYLE[status]}>{KNOWLEDGE_STATUS_LABELS[status]}</Badge>;
}

function StatusSelect({ id, value, onChange, canApprove }: { id: string; value: KnowledgeStatus; onChange: (s: KnowledgeStatus) => void; canApprove: boolean }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value as KnowledgeStatus)}>
      {KNOWLEDGE_STATUSES.map((s) => (
        <option key={s} value={s} disabled={s === "getsecure_approved" && !canApprove}>
          {KNOWLEDGE_STATUS_LABELS[s]}
        </option>
      ))}
    </Select>
  );
}

function useAction() {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const run = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done?: (d: T) => string) => {
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error);
      if (done) setMsg(done(res.data));
      router.refresh();
    });
  };
  return { error, msg, pending, run };
}

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

// ---------- policies ----------

export type PolicyRow = { key: string; description: string; value: unknown; status: KnowledgeStatus; source: string | null; notes: string | null; approvedBy: string | null; approvedAt: string | null };

function PolicyEditor({ row, canApprove }: { row: PolicyRow; canApprove: boolean }) {
  const [value, setValue] = React.useState(JSON.stringify(row.value, null, row.value && typeof row.value === "object" ? 2 : 0));
  const [status, setStatus] = React.useState(row.status);
  const [notes, setNotes] = React.useState(row.notes ?? "");
  const a = useAction();
  return (
    <div className="grid gap-2 border-t border-gray-100 px-4 py-3 text-sm lg:grid-cols-[16rem_1fr_14rem]" data-testid={`policy-${row.key}`}>
      <div>
        <p className="font-medium text-gray-900">{row.description}</p>
        <p className="text-xs text-gray-500">{row.key}</p>
        <div className="mt-1">
          <StatusBadge status={row.status} />
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {row.source}
          {row.approvedBy ? ` · approved by ${row.approvedBy}${row.approvedAt ? ` ${row.approvedAt}` : ""}` : ""}
        </p>
      </div>
      <div className="space-y-1">
        <Textarea value={value} onChange={(e) => setValue(e.target.value)} className="min-h-10 font-mono text-xs" aria-label={`${row.key} value`} />
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" className="h-8 text-xs" />
      </div>
      <div className="space-y-1">
        <StatusSelect id={`ps-${row.key}`} value={status} onChange={setStatus} canApprove={canApprove} />
        <Button size="sm" variant="secondary" disabled={a.pending} onClick={() => a.run(() => savePolicyAction(row.key, value, status, notes), () => "Saved.")}>
          Save
        </Button>
        {a.msg ? <p className="text-xs text-green-700">{a.msg}</p> : null}
        <FormError message={a.error} />
      </div>
    </div>
  );
}

// ---------- products ----------

const SPEC_TEMPLATES: Record<string, Record<string, unknown>> = {
  camera: { resolutionMp: 4, horizontalPixels: 2560, hfovDeg: 100, lensMm: 2.8, irRangeM: 30, colourNight: false, wdrDb: 120, codecs: ["H.265", "H.264"], expectedBitrateMbps: null, maxBitrateMbps: null, poeWatts: null, analytics: [], audio: false, onvifProfiles: ["S", "T"] },
  nvr: { channels: 4, incomingMbps: 40, poePorts: 4, poePerPortW: null, poeBudgetW: null, hddBays: 1, maxHddTb: 10, maxTotalTb: 10, features: [], audio: false, alarmIo: false, onvifProfiles: ["S", "T"] },
  hdd: { capacityTb: 4, surveillanceRated: true },
  poe_switch: { poePorts: 8, poePerPortW: 30, poeBudgetW: 120 },
};
const CATEGORIES = ["camera", "nvr", "hdd", "poe_switch", "network", "router_4g", "ups", "monitor", "cable", "junction_box", "conduit", "accessory", "other"];

export type OfferRow = { id: string; supplier: string; sku: string | null; costExGst: number | null; pendingCostExGst: number | null; approved: boolean; lastChecked: string | null };
export type ProductRowView = {
  id: string;
  manufacturer: string;
  model: string;
  category: string;
  market: string;
  tier: string | null;
  specs: Record<string, unknown>;
  warranty: string | null;
  status: KnowledgeStatus;
  source: string | null;
  sourceUrl: string | null;
  notes: string | null;
  offers: OfferRow[];
};

function ProductForm({ product, canApprove, onDone }: { product: ProductRowView | null; canApprove: boolean; onDone?: () => void }) {
  const [category, setCategory] = React.useState(product?.category ?? "camera");
  const [manufacturer, setManufacturer] = React.useState(product?.manufacturer ?? "");
  const [model, setModel] = React.useState(product?.model ?? "");
  const [market, setMarket] = React.useState(product?.market ?? "residential");
  const [tier, setTier] = React.useState(product?.tier ?? "");
  const [specs, setSpecs] = React.useState(JSON.stringify(product?.specs ?? SPEC_TEMPLATES.camera, null, 2));
  const [status, setStatus] = React.useState<KnowledgeStatus>(product?.status ?? "manufacturer_verified");
  const [sourceUrl, setSourceUrl] = React.useState(product?.sourceUrl ?? "");
  const [notes, setNotes] = React.useState(product?.notes ?? "");
  const a = useAction();
  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(specs);
    } catch {
      return a.run(async () => ({ ok: false as const, error: "Specification must be valid JSON." }));
    }
    a.run(
      () => saveProductAction({ id: product?.id ?? null, manufacturer, model, category, market, tier: tier || null, specs: parsed, status, sourceUrl: sourceUrl || null, notes: notes || null }),
      () => {
        onDone?.();
        return "Saved.";
      },
    );
  };
  return (
    <div className="grid gap-3 p-4 text-sm sm:grid-cols-3">
      <Field label="Category" htmlFor={`pc-${product?.id ?? "new"}`}>
        <Select
          id={`pc-${product?.id ?? "new"}`}
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            if (!product) setSpecs(JSON.stringify(SPEC_TEMPLATES[e.target.value] ?? {}, null, 2));
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Manufacturer" htmlFor={`pm-${product?.id ?? "new"}`}>
        <Input id={`pm-${product?.id ?? "new"}`} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
      </Field>
      <Field label="Model" htmlFor={`pmo-${product?.id ?? "new"}`}>
        <Input id={`pmo-${product?.id ?? "new"}`} value={model} onChange={(e) => setModel(e.target.value)} />
      </Field>
      <Field label="Market" htmlFor={`pk-${product?.id ?? "new"}`}>
        <Select id={`pk-${product?.id ?? "new"}`} value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
          <option value="both">Both</option>
        </Select>
      </Field>
      <Field label="Tier" htmlFor={`pt-${product?.id ?? "new"}`}>
        <Select id={`pt-${product?.id ?? "new"}`} value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">None</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status" htmlFor={`pst-${product?.id ?? "new"}`}>
        <StatusSelect id={`pst-${product?.id ?? "new"}`} value={status} onChange={setStatus} canApprove={canApprove} />
      </Field>
      <Field label="Specification (from the manufacturer's datasheet)" htmlFor={`psp-${product?.id ?? "new"}`} className="sm:col-span-2">
        <Textarea id={`psp-${product?.id ?? "new"}`} value={specs} onChange={(e) => setSpecs(e.target.value)} className="min-h-48 font-mono text-xs" />
      </Field>
      <div className="space-y-3">
        <Field label="Datasheet URL" htmlFor={`pu-${product?.id ?? "new"}`}>
          <Input id={`pu-${product?.id ?? "new"}`} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        </Field>
        <Field label="Notes" htmlFor={`pn-${product?.id ?? "new"}`}>
          <Textarea id={`pn-${product?.id ?? "new"}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button size="sm" onClick={save} disabled={a.pending || !manufacturer || !model}>
          {product ? "Save product" : "Add product"}
        </Button>
        {a.msg ? <p className="text-xs text-green-700">{a.msg}</p> : null}
        <FormError message={a.error} />
      </div>
    </div>
  );
}

function PriceForm({ productId, suppliers }: { productId: string; suppliers: { id: string; name: string }[] }) {
  const [supplierId, setSupplierId] = React.useState(suppliers[0]?.id ?? "");
  const [ex, setEx] = React.useState("");
  const [inc, setInc] = React.useState("");
  const [sku, setSku] = React.useState("");
  const a = useAction();
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-8 w-36 text-xs" aria-label="Supplier">
        {suppliers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Supplier SKU" className="h-8 w-28 text-xs" />
      <Input value={ex} onChange={(e) => setEx(e.target.value)} placeholder="Cost ex GST" type="number" className="h-8 w-28 text-xs" aria-label="Cost ex GST" />
      <Input value={inc} onChange={(e) => setInc(e.target.value)} placeholder="or inc GST" type="number" className="h-8 w-24 text-xs" />
      <Button
        size="sm"
        variant="secondary"
        disabled={a.pending || (!ex && !inc) || !supplierId}
        onClick={() =>
          a.run(
            () => recordPriceAction({ productId, supplierId, costExGst: ex ? Number(ex) : null, costIncGst: inc ? Number(inc) : null, supplierSku: sku || null }),
            (d) => (d.held ? `Held for review: ${d.changedPct}% change.` : "Price recorded."),
          )
        }
      >
        Record price
      </Button>
      {a.msg ? <span className="text-green-700">{a.msg}</span> : null}
      <FormError message={a.error} />
    </div>
  );
}

function ProductRowItem({ p, canApprove, suppliers }: { p: ProductRowView; canApprove: boolean; suppliers: { id: string; name: string }[] }) {
  const [open, setOpen] = React.useState(false);
  const a = useAction();
  const best = p.offers.find((o) => o.approved && o.costExGst != null) ?? null;
  return (
    <div className="border-t border-gray-100" data-testid="product-row">
      <button type="button" onClick={() => setOpen((v) => !v)} className="grid w-full grid-cols-[1fr_6rem_6rem_9rem_8rem] items-center gap-2 px-4 py-2 text-left text-sm hover:bg-gray-50">
        <span className="font-medium text-gray-900">
          {p.manufacturer} {p.model}
        </span>
        <span className="text-gray-600">{p.category}</span>
        <span className="text-gray-600">{p.tier ?? p.market}</span>
        <StatusBadge status={p.status} />
        <span className="text-right">{best ? `$${best.costExGst!.toFixed(2)} ex` : <span className="text-amber-700">no approved price</span>}</span>
      </button>
      {open ? (
        <div className="bg-gray-50">
          <ProductForm product={p} canApprove={canApprove} />
          <div className="space-y-2 border-t border-gray-200 px-4 py-3">
            <p className="text-xs font-semibold text-gray-700">Supplier prices</p>
            {p.offers.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-32 font-medium">{o.supplier}</span>
                <span className="w-24 text-gray-600">{o.sku ?? "—"}</span>
                <span className="w-28">{o.costExGst != null ? `$${o.costExGst.toFixed(2)} ex GST` : "—"}</span>
                {o.pendingCostExGst != null ? <Badge className="bg-amber-100 text-amber-800">pending ${o.pendingCostExGst.toFixed(2)}</Badge> : null}
                <Badge className={o.approved ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{o.approved ? "approved" : "not approved"}</Badge>
                <span className="text-gray-500">{o.lastChecked ? `checked ${o.lastChecked}` : ""}</span>
                {canApprove && (!o.approved || o.pendingCostExGst != null) ? (
                  <Button size="sm" variant="secondary" disabled={a.pending} onClick={() => a.run(() => approvePriceAction(o.id))}>
                    Approve price
                  </Button>
                ) : null}
              </div>
            ))}
            <PriceForm productId={p.id} suppliers={suppliers} />
            <FormError message={a.error} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------- suppliers ----------

export type SupplierView = {
  id: string;
  name: string;
  website: string | null;
  accountStatus: string | null;
  priceSourceType: string;
  integrationMethod: string | null;
  priority: number;
  brands: string[];
  status: KnowledgeStatus;
  notes: string | null;
  lastPriceSyncAt: string | null;
  hasCredential: boolean;
};

function SupplierForm({ s, canApprove }: { s: SupplierView | null; canApprove: boolean }) {
  const [v, setV] = React.useState({
    name: s?.name ?? "",
    website: s?.website ?? "",
    accountStatus: s?.accountStatus ?? "",
    priceSourceType: s?.priceSourceType ?? "manual",
    integrationMethod: s?.integrationMethod ?? "",
    priority: String(s?.priority ?? 100),
    brands: (s?.brands ?? []).join(", "),
    status: (s?.status ?? "requires_review") as KnowledgeStatus,
    notes: s?.notes ?? "",
  });
  const [user, setUser] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const a = useAction();
  const set = (k: keyof typeof v, val: string) => setV((cur) => ({ ...cur, [k]: val }));
  const id = s?.id ?? "new";
  return (
    <div className="grid gap-2 border-t border-gray-100 p-4 text-sm sm:grid-cols-4" data-testid="supplier-form">
      <Field label="Name" htmlFor={`sn-${id}`}>
        <Input id={`sn-${id}`} value={v.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Website" htmlFor={`sw-${id}`}>
        <Input id={`sw-${id}`} value={v.website} onChange={(e) => set("website", e.target.value)} />
      </Field>
      <Field label="Priority" htmlFor={`sp-${id}`}>
        <Input id={`sp-${id}`} type="number" value={v.priority} onChange={(e) => set("priority", e.target.value)} />
      </Field>
      <Field label="Status" htmlFor={`ss-${id}`}>
        <StatusSelect id={`ss-${id}`} value={v.status} onChange={(x) => set("status", x)} canApprove={canApprove} />
      </Field>
      <Field label="Account status" htmlFor={`sa-${id}`}>
        <Input id={`sa-${id}`} value={v.accountStatus} onChange={(e) => set("accountStatus", e.target.value)} />
      </Field>
      <Field label="Price source" htmlFor={`spt-${id}`}>
        <Select id={`spt-${id}`} value={v.priceSourceType} onChange={(e) => set("priceSourceType", e.target.value)}>
          <option value="manual">Manual</option>
          <option value="csv">CSV / price list</option>
          <option value="portal">Supplier portal</option>
          <option value="api">API</option>
        </Select>
      </Field>
      <Field label="Integration / login method" htmlFor={`si-${id}`}>
        <Input id={`si-${id}`} value={v.integrationMethod} onChange={(e) => set("integrationMethod", e.target.value)} />
      </Field>
      <Field label="Brands (comma separated)" htmlFor={`sb-${id}`}>
        <Input id={`sb-${id}`} value={v.brands} onChange={(e) => set("brands", e.target.value)} />
      </Field>
      <Field label="Notes" htmlFor={`snn-${id}`} className="sm:col-span-4">
        <Input id={`snn-${id}`} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
        <Button
          size="sm"
          variant="secondary"
          disabled={a.pending || !v.name}
          onClick={() =>
            a.run(
              () =>
                saveSupplierAction({
                  id: s?.id ?? null,
                  ...v,
                  priority: Number(v.priority),
                  brands: csv(v.brands),
                  website: v.website || null,
                  accountStatus: v.accountStatus || null,
                  integrationMethod: v.integrationMethod || null,
                  notes: v.notes || null,
                }),
              () => "Saved.",
            )
          }
        >
          {s ? "Save supplier" : "Add supplier"}
        </Button>
        {s ? (
          <>
            <span className="ml-4 text-xs text-gray-500">Login {s.hasCredential ? "stored (encrypted)" : "not stored"}:</span>
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Username" className="h-8 w-36 text-xs" autoComplete="off" />
            <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Password / API key" type="password" className="h-8 w-40 text-xs" autoComplete="new-password" />
            <Button size="sm" variant="secondary" disabled={a.pending || !secret} onClick={() => a.run(() => setSupplierCredentialAction(s.id, user, secret), () => "Login stored, encrypted.")}>
              Store login
            </Button>
          </>
        ) : null}
        {a.msg ? <span className="text-xs text-green-700">{a.msg}</span> : null}
        <FormError message={a.error} />
      </div>
    </div>
  );
}

// ---------- packages ----------

export type PackageView = {
  id: string;
  name: string;
  propertyType: string;
  minCameras: number;
  maxCameras: number;
  storeys: number | null;
  estimatedHours: number;
  allowanceExGst: number;
  includedMaterials: string[];
  assumptions: string[];
  exclusions: string[];
  version: number;
  status: KnowledgeStatus;
  notes: string | null;
};

function PackageForm({ p, canApprove }: { p: PackageView | null; canApprove: boolean }) {
  const [v, setV] = React.useState({
    name: p?.name ?? "",
    propertyType: p?.propertyType ?? "residential",
    minCameras: String(p?.minCameras ?? 1),
    maxCameras: String(p?.maxCameras ?? 4),
    storeys: p?.storeys != null ? String(p.storeys) : "1",
    estimatedHours: p ? String(p.estimatedHours) : "",
    allowanceExGst: p ? String(p.allowanceExGst) : "",
    includedMaterials: (p?.includedMaterials ?? []).join(", "),
    assumptions: (p?.assumptions ?? []).join(", "),
    exclusions: (p?.exclusions ?? []).join(", "),
    status: (p?.status ?? "getsecure_provisional") as KnowledgeStatus,
    notes: p?.notes ?? "",
  });
  const a = useAction();
  const set = (k: keyof typeof v, val: string) => setV((cur) => ({ ...cur, [k]: val }));
  const id = p?.id ?? "new";
  return (
    <div className="grid gap-2 border-t border-gray-100 p-4 text-sm sm:grid-cols-4" data-testid="package-form">
      <Field label="Name" htmlFor={`kn-${id}`} className="sm:col-span-2">
        <Input id={`kn-${id}`} value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="1-4 cameras, single storey" />
      </Field>
      <Field label="Property" htmlFor={`kp-${id}`}>
        <Select id={`kp-${id}`} value={v.propertyType} onChange={(e) => set("propertyType", e.target.value)}>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </Select>
      </Field>
      <Field label="Status" htmlFor={`ks-${id}`}>
        <StatusSelect id={`ks-${id}`} value={v.status} onChange={(x) => set("status", x)} canApprove={canApprove} />
      </Field>
      <Field label="Cameras from" htmlFor={`kmin-${id}`}>
        <Input id={`kmin-${id}`} type="number" value={v.minCameras} onChange={(e) => set("minCameras", e.target.value)} />
      </Field>
      <Field label="Cameras to" htmlFor={`kmax-${id}`}>
        <Input id={`kmax-${id}`} type="number" value={v.maxCameras} onChange={(e) => set("maxCameras", e.target.value)} />
      </Field>
      <Field label="Storeys (blank = any)" htmlFor={`kst-${id}`}>
        <Input id={`kst-${id}`} type="number" value={v.storeys} onChange={(e) => set("storeys", e.target.value)} />
      </Field>
      <Field label="Estimated hours" htmlFor={`kh-${id}`}>
        <Input id={`kh-${id}`} type="number" value={v.estimatedHours} onChange={(e) => set("estimatedHours", e.target.value)} />
      </Field>
      <Field label="Installation allowance, ex GST ($)" htmlFor={`ka-${id}`}>
        <Input id={`ka-${id}`} type="number" value={v.allowanceExGst} onChange={(e) => set("allowanceExGst", e.target.value)} />
      </Field>
      <Field label="Included materials" htmlFor={`ki-${id}`} className="sm:col-span-3">
        <Input id={`ki-${id}`} value={v.includedMaterials} onChange={(e) => set("includedMaterials", e.target.value)} />
      </Field>
      <Field label="Assumptions" htmlFor={`kas-${id}`} className="sm:col-span-2">
        <Input id={`kas-${id}`} value={v.assumptions} onChange={(e) => set("assumptions", e.target.value)} />
      </Field>
      <Field label="Exclusions" htmlFor={`kex-${id}`} className="sm:col-span-2">
        <Input id={`kex-${id}`} value={v.exclusions} onChange={(e) => set("exclusions", e.target.value)} />
      </Field>
      <div className="flex items-center gap-2 sm:col-span-4">
        <Button
          size="sm"
          variant="secondary"
          disabled={a.pending || !v.name || !v.estimatedHours || !v.allowanceExGst}
          onClick={() =>
            a.run(
              () =>
                savePackageAction({
                  id: p?.id ?? null,
                  name: v.name,
                  propertyType: v.propertyType,
                  minCameras: Number(v.minCameras),
                  maxCameras: Number(v.maxCameras),
                  storeys: v.storeys ? Number(v.storeys) : null,
                  estimatedHours: Number(v.estimatedHours),
                  allowanceExGst: Number(v.allowanceExGst),
                  includedMaterials: csv(v.includedMaterials),
                  assumptions: csv(v.assumptions),
                  exclusions: csv(v.exclusions),
                  status: v.status,
                  notes: v.notes || null,
                }),
              () => "Saved.",
            )
          }
        >
          {p ? `Save (becomes v${p.version + 1})` : "Add package"}
        </Button>
        {a.msg ? <span className="text-xs text-green-700">{a.msg}</span> : null}
        <FormError message={a.error} />
      </div>
    </div>
  );
}

// ---------- page ----------

const TABS = [
  { key: "policies", label: "Rules" },
  { key: "products", label: "Products & prices" },
  { key: "suppliers", label: "Suppliers" },
  { key: "packages", label: "Installation packages" },
] as const;

export function BrainSettings({
  tab,
  canApprove,
  policies,
  products,
  suppliers,
  packages,
}: {
  tab: string;
  canApprove: boolean;
  policies: PolicyRow[];
  products: ProductRowView[];
  suppliers: SupplierView[];
  packages: PackageView[];
}) {
  const [adding, setAdding] = React.useState(false);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Business Brain</h1>
        <p className="text-sm text-gray-600">
          The rules, products, prices and installation packages the CCTV assessment uses. Every record shows where it came from. Only{" "}
          {canApprove ? "you" : "Chris"} can mark anything Get Secure approved, and nothing here is filled in by AI.
        </p>
      </div>
      <div className="flex gap-1 border-b border-gray-200 text-sm">
        {TABS.map((t) => (
          <Link key={t.key} href={`/settings/brain?tab=${t.key}`} className={cn("-mb-px border-b-2 px-3 py-2", tab === t.key ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900")}>
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "policies" ? (
        <Card>
          <CardHeader title="Rules and settings" />
          {policies.map((r) => (
            <PolicyEditor key={r.key} row={r} canApprove={canApprove} />
          ))}
        </Card>
      ) : null}

      {tab === "products" ? (
        <Card>
          <CardHeader
            title={`Products · ${products.length}`}
            action={
              <Button size="sm" variant="secondary" onClick={() => setAdding((x) => !x)}>
                {adding ? "Close" : "Add product"}
              </Button>
            }
          />
          {adding ? <ProductForm product={null} canApprove={canApprove} onDone={() => setAdding(false)} /> : null}
          {products.length === 0 ? <p className="px-4 py-6 text-sm text-gray-500">No products yet. Add them from manufacturer datasheets and supplier price lists; the assessment only uses what is here.</p> : null}
          {products.map((p) => (
            <ProductRowItem key={p.id} p={p} canApprove={canApprove} suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))} />
          ))}
        </Card>
      ) : null}

      {tab === "suppliers" ? (
        <Card>
          <CardHeader title="Suppliers" />
          <p className="px-4 pt-2 text-xs text-gray-500">Logins are stored encrypted and are never shown again or given to any agent.</p>
          {suppliers.map((s) => (
            <SupplierForm key={s.id} s={s} canApprove={canApprove} />
          ))}
          <SupplierForm s={null} canApprove={canApprove} />
        </Card>
      ) : null}

      {tab === "packages" ? (
        <Card>
          <CardHeader title="Installation packages" />
          <p className="px-4 pt-2 text-xs text-gray-500">Residential labour is priced from these packages, not hours × rate. Enter them from Get Secure job history.</p>
          {packages.map((p) => (
            <PackageForm key={p.id} p={p} canApprove={canApprove} />
          ))}
          <PackageForm p={null} canApprove={canApprove} />
        </Card>
      ) : null}
    </div>
  );
}
