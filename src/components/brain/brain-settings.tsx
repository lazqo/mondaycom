"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  approvePriceAction,
  deleteLinkAction,
  deleteRouteAction,
  importSupplierCsvAction,
  recordPriceAction,
  saveLinkAction,
  saveMaterialsPackageAction,
  savePackageAction,
  savePolicyAction,
  saveProductAction,
  saveRouteAction,
  saveSupplierAction,
  setSupplierCredentialAction,
} from "@/actions/catalogue";
import { Badge, Button, Card, CardHeader, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { COMPATIBILITY_KINDS, KNOWLEDGE_STATUSES, KNOWLEDGE_STATUS_LABELS, TIERS, type KnowledgeStatus, type PriceFreshness } from "@/lib/brain/types";
import { cn } from "@/lib/utils";
import { ProductProposalContent, type ProductQuoteContent } from "./product-proposal-content";
import { KitSettings, type KitProductOption, type KitView } from "./kit-settings";
import { SupplierPricing, type ConnectorView } from "./supplier-pricing";
import type { SupplierPricingSettings } from "@/lib/brain/supplier-settings";

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
  camera: {
    resolutionMp: 4,
    horizontalPixels: 2560,
    hfovDeg: 100,
    lensMm: 2.8,
    irRangeM: 30,
    whiteLightRangeM: null,
    colourNight: false,
    wdrDb: 120,
    codecs: ["H.265", "H.264"],
    expectedBitrateMbps: null,
    maxBitrateMbps: null,
    poeWatts: null,
    analytics: [],
    audio: false,
    speaker: false,
    ingress: ["IP67"],
    onvifProfiles: ["S"],
  },
  nvr: {
    channels: 4,
    incomingMbps: 40,
    outgoingMbps: null,
    poePorts: 4,
    poePerPortW: null,
    poeBudgetW: null,
    hddBays: 1,
    maxHddTb: 10,
    maxTotalTb: 10,
    recordingResolutionMaxMp: 8,
    decoding: { "8": 1, "4": 4 },
    features: [],
    audio: false,
    alarmIo: false,
    compatibleFamilies: [],
    onvifProfiles: ["S"],
  },
  hdd: { capacityTb: 4, surveillanceRated: true },
  poe_switch: { poePorts: 8, poePerPortW: 30, poeBudgetW: 120 },
};
const CATEGORIES = ["camera", "nvr", "hdd", "poe_switch", "network", "router_4g", "ups", "monitor", "cable", "junction_box", "wall_bracket", "pole_bracket", "conduit", "accessory", "kit", "other"];
const LINK_LABELS: Record<string, string> = {
  camera_nvr: "Camera ↔ recorder",
  camera_junction_box: "Camera → junction box",
  camera_wall_bracket: "Camera → wall bracket",
  camera_pole_bracket: "Camera → pole bracket",
  nvr_hdd: "Recorder → hard drive",
  kit_component: "Kit → component",
};
const FRESH_STYLE: Record<PriceFreshness, string> = {
  current: "bg-green-100 text-green-800",
  aging: "bg-amber-100 text-amber-800",
  stale: "bg-red-100 text-red-800",
  unknown: "bg-gray-200 text-gray-700",
};

export type OfferRow = {
  id: string;
  supplier: string;
  sku: string | null;
  costExGst: number | null;
  pendingCostExGst: number | null;
  approved: boolean;
  poa: boolean;
  stock: string | null;
  priceSource: string | null;
  lastChecked: string | null;
  freshness: PriceFreshness;
};
export type LinkRow = { id: string; kind: string; direction: "from" | "to"; other: string; otherId: string; quantity: number; status: KnowledgeStatus };
export type ProductRowView = {
  id: string;
  manufacturer: string;
  family: string | null;
  model: string;
  category: string;
  formFactor: string | null;
  residentialAllowed: boolean;
  commercialAllowed: boolean;
  tier: string | null;
  tierStatus: KnowledgeStatus;
  ecosystem: string[];
  specs: Record<string, unknown>;
  unverifiedFields: string[];
  lastVerified: string | null;
  warranty: string | null;
  status: KnowledgeStatus;
  source: string | null;
  sourceUrl: string | null;
  notes: string | null;
  quote: ProductQuoteContent;
  offers: OfferRow[];
  links: LinkRow[];
};

function ProductForm({ product, canApprove, onDone }: { product: ProductRowView | null; canApprove: boolean; onDone?: () => void }) {
  const [category, setCategory] = React.useState(product?.category ?? "camera");
  const [manufacturer, setManufacturer] = React.useState(product?.manufacturer ?? "");
  const [family, setFamily] = React.useState(product?.family ?? "");
  const [model, setModel] = React.useState(product?.model ?? "");
  const [formFactor, setFormFactor] = React.useState(product?.formFactor ?? "");
  const [residentialAllowed, setResidential] = React.useState(product?.residentialAllowed ?? true);
  const [commercialAllowed, setCommercial] = React.useState(product?.commercialAllowed ?? false);
  const [tier, setTier] = React.useState(product?.tier ?? "");
  const [tierStatus, setTierStatus] = React.useState<KnowledgeStatus>(product?.tierStatus ?? "getsecure_provisional");
  const [ecosystem, setEcosystem] = React.useState((product?.ecosystem ?? []).join(", "));
  const [specs, setSpecs] = React.useState(JSON.stringify(product?.specs ?? SPEC_TEMPLATES.camera, null, 2));
  const [status, setStatus] = React.useState<KnowledgeStatus>(product?.status ?? "manufacturer_verified");
  const [sourceUrl, setSourceUrl] = React.useState(product?.sourceUrl ?? "");
  const [notes, setNotes] = React.useState(product?.notes ?? "");
  const a = useAction();
  const id = product?.id ?? "new";
  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(specs);
    } catch {
      return a.run(async () => ({ ok: false as const, error: "Specification must be valid JSON." }));
    }
    a.run(
      () =>
        saveProductAction({
          id: product?.id ?? null,
          manufacturer,
          family: family || null,
          model,
          category,
          formFactor: formFactor || null,
          residentialAllowed,
          commercialAllowed,
          tier: tier || null,
          tierStatus,
          ecosystem: csv(ecosystem),
          specs: parsed,
          status,
          sourceUrl: sourceUrl || null,
          notes: notes || null,
        }),
      () => {
        onDone?.();
        return "Saved.";
      },
    );
  };
  return (
    <div className="grid gap-3 p-4 text-sm sm:grid-cols-4">
      <Field label="Category" htmlFor={`pc-${id}`}>
        <Select
          id={`pc-${id}`}
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
      <Field label="Manufacturer" htmlFor={`pm-${id}`}>
        <Input id={`pm-${id}`} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
      </Field>
      <Field label="Brand / family" htmlFor={`pf-${id}`} hint="Used for supplier routes and tiers">
        <Input id={`pf-${id}`} value={family} onChange={(e) => setFamily(e.target.value)} placeholder={manufacturer} />
      </Field>
      <Field label="Model" htmlFor={`pmo-${id}`}>
        <Input id={`pmo-${id}`} value={model} onChange={(e) => setModel(e.target.value)} />
      </Field>
      <Field label="Form factor" htmlFor={`pff-${id}`}>
        <Input id={`pff-${id}`} value={formFactor} onChange={(e) => setFormFactor(e.target.value)} placeholder="turret, bullet, dome…" />
      </Field>
      <div className="space-y-1 pt-5">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={residentialAllowed} onChange={(e) => setResidential(e.target.checked)} /> Residential allowed
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={commercialAllowed} onChange={(e) => setCommercial(e.target.checked)} /> Commercial allowed
        </label>
      </div>
      <Field label="Get Secure tier" htmlFor={`pt-${id}`} hint="A value position, not a megapixel rule">
        <Select id={`pt-${id}`} value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">None (not on the residential ladder)</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Tier status" htmlFor={`pts-${id}`}>
        <StatusSelect id={`pts-${id}`} value={tierStatus} onChange={setTierStatus} canApprove={canApprove} />
      </Field>
      <Field label="Specification status" htmlFor={`pst-${id}`}>
        <StatusSelect id={`pst-${id}`} value={status} onChange={setStatus} canApprove={canApprove} />
      </Field>
      <Field label="App / ecosystem" htmlFor={`pe-${id}`}>
        <Input id={`pe-${id}`} value={ecosystem} onChange={(e) => setEcosystem(e.target.value)} placeholder="Hik-Connect, VIGI App…" />
      </Field>
      <Field label="Datasheet / source URL" htmlFor={`pu-${id}`} className="sm:col-span-2">
        <Input id={`pu-${id}`} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
      </Field>
      <Field
        label="Specification (only what the manufacturer publishes; expectedBitrateMbps is Get Secure's planning figure)"
        htmlFor={`psp-${id}`}
        className="sm:col-span-3"
      >
        <Textarea id={`psp-${id}`} value={specs} onChange={(e) => setSpecs(e.target.value)} className="min-h-48 font-mono text-xs" />
      </Field>
      <div className="space-y-3">
        {product ? (
          <div className="text-xs text-gray-600">
            <p>{product.lastVerified ? `Verified ${product.lastVerified}` : "Not verified against a source"}</p>
            {product.source ? <p>{product.source}</p> : null}
            {product.unverifiedFields.length ? <p className="text-amber-700">Not published by the source: {product.unverifiedFields.join(", ")}</p> : null}
          </div>
        ) : null}
        <Field label="Notes" htmlFor={`pn-${id}`}>
          <Textarea id={`pn-${id}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
  const [stock, setStock] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [poa, setPoa] = React.useState(false);
  const a = useAction();
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-8 w-40 text-xs" aria-label="Supplier">
        {suppliers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Supplier SKU" className="h-8 w-28 text-xs" />
      <Input value={ex} onChange={(e) => setEx(e.target.value)} placeholder="Cost ex GST" type="number" className="h-8 w-28 text-xs" aria-label="Cost ex GST" disabled={poa} />
      <Input value={inc} onChange={(e) => setInc(e.target.value)} placeholder="or inc GST" type="number" className="h-8 w-24 text-xs" disabled={poa} />
      <Input value={stock} onChange={(e) => setStock(e.target.value)} placeholder="Stock" className="h-8 w-20 text-xs" />
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Listing URL" className="h-8 w-40 text-xs" />
      <label className="flex h-8 items-center gap-1">
        <input type="checkbox" checked={poa} onChange={(e) => setPoa(e.target.checked)} /> POA
      </label>
      <Button
        size="sm"
        variant="secondary"
        disabled={a.pending || (!poa && !ex && !inc) || !supplierId}
        onClick={() =>
          a.run(
            () =>
              recordPriceAction({
                productId,
                supplierId,
                costExGst: !poa && ex ? Number(ex) : null,
                costIncGst: !poa && inc ? Number(inc) : null,
                supplierSku: sku || null,
                stock: stock || null,
                sourceUrl: url || null,
                priceOnApplication: poa,
              }),
            (d) => (poa ? "Recorded as price on application." : d.held ? `Held for review: ${d.changedPct}% change.` : "Price recorded."),
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

function LinkForm({ productId, products }: { productId: string; products: { id: string; label: string; category: string }[] }) {
  const [kind, setKind] = React.useState<string>("camera_junction_box");
  const [to, setTo] = React.useState("");
  const [qty, setQty] = React.useState("1");
  const [url, setUrl] = React.useState("");
  const a = useAction();
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <Select value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 w-48 text-xs" aria-label="Relationship">
        {COMPATIBILITY_KINDS.map((k) => (
          <option key={k} value={k}>
            {LINK_LABELS[k]}
          </option>
        ))}
      </Select>
      <Select value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-64 text-xs" aria-label="Related product">
        <option value="">Choose product…</option>
        {products
          .filter((p) => p.id !== productId)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.category})
            </option>
          ))}
      </Select>
      {kind === "kit_component" ? <Input value={qty} onChange={(e) => setQty(e.target.value)} type="number" className="h-8 w-16 text-xs" aria-label="Quantity" /> : null}
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Where it is documented (URL)" className="h-8 w-56 text-xs" />
      <Button size="sm" variant="secondary" disabled={a.pending || !to} onClick={() => a.run(() => saveLinkAction({ kind, fromProductId: productId, toProductId: to, quantity: Number(qty) || 1, sourceUrl: url || null }), () => "Linked.")}>
        Add relationship
      </Button>
      {a.msg ? <span className="text-green-700">{a.msg}</span> : null}
      <FormError message={a.error} />
    </div>
  );
}

function ProductRowItem({ p, canApprove, suppliers, allProducts }: { p: ProductRowView; canApprove: boolean; suppliers: { id: string; name: string }[]; allProducts: { id: string; label: string; category: string }[] }) {
  const [open, setOpen] = React.useState(false);
  const a = useAction();
  const best = p.offers.find((o) => o.approved && o.costExGst != null) ?? null;
  return (
    <div className="border-t border-gray-100" data-testid="product-row">
      <button type="button" onClick={() => setOpen((v) => !v)} className="grid w-full grid-cols-[1fr_6rem_6rem_9rem_9rem] items-center gap-2 px-4 py-2 text-left text-sm hover:bg-gray-50">
        <span className="font-medium text-gray-900">
          {p.manufacturer} {p.model}
          {p.family && p.family !== p.manufacturer ? <span className="ml-1 text-xs font-normal text-gray-500">{p.family}</span> : null}
        </span>
        <span className="text-gray-600">{p.category}</span>
        <span className="text-gray-600">{p.tier ?? (p.commercialAllowed && !p.residentialAllowed ? "commercial" : "—")}</span>
        <StatusBadge status={p.status} />
        <span className="text-right">
          {best ? (
            <>
              ${best.costExGst!.toFixed(2)} ex <Badge className={FRESH_STYLE[best.freshness]}>{best.freshness}</Badge>
            </>
          ) : (
            <span className="text-amber-700">no approved price</span>
          )}
        </span>
      </button>
      {open ? (
        <div className="bg-gray-50">
          <ProductForm product={p} canApprove={canApprove} />
          <ProductProposalContent productId={p.id} content={p.quote} canApprove={canApprove} />
          <div className="space-y-2 border-t border-gray-200 px-4 py-3">
            <p className="text-xs font-semibold text-gray-700">Supplier listings</p>
            {p.offers.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-40 font-medium">{o.supplier}</span>
                <span className="w-24 text-gray-600">{o.sku ?? "—"}</span>
                <span className="w-28">{o.poa ? "POA" : o.costExGst != null ? `$${o.costExGst.toFixed(2)} ex GST` : "—"}</span>
                {o.pendingCostExGst != null ? <Badge className="bg-amber-100 text-amber-800">pending ${o.pendingCostExGst.toFixed(2)}</Badge> : null}
                <Badge className={o.approved ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{o.approved ? "approved" : "not approved"}</Badge>
                <Badge className={FRESH_STYLE[o.freshness]}>{o.freshness}</Badge>
                <span className="text-gray-500">
                  {o.lastChecked ? `checked ${o.lastChecked}` : ""}
                  {o.stock ? ` · stock ${o.stock}` : ""}
                  {o.priceSource ? ` · ${o.priceSource}` : ""}
                </span>
                {canApprove && !o.poa && (!o.approved || o.pendingCostExGst != null) ? (
                  <Button size="sm" variant="secondary" disabled={a.pending} onClick={() => a.run(() => approvePriceAction(o.id))}>
                    Approve price
                  </Button>
                ) : null}
              </div>
            ))}
            <PriceForm productId={p.id} suppliers={suppliers} />
          </div>
          <div className="space-y-2 border-t border-gray-200 px-4 py-3" data-testid="product-links">
            <p className="text-xs font-semibold text-gray-700">Compatibility</p>
            {p.links.length === 0 ? <p className="text-xs text-gray-500">No documented relationships.</p> : null}
            {p.links.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-48 text-gray-600">{LINK_LABELS[l.kind] ?? l.kind}</span>
                <span className="font-medium">
                  {l.direction === "to" ? "← " : ""}
                  {l.other}
                  {l.kind === "kit_component" ? ` × ${l.quantity}` : ""}
                </span>
                <StatusBadge status={l.status} />
                <Button size="sm" variant="ghost" className="text-red-600" disabled={a.pending} onClick={() => a.run(() => deleteLinkAction(l.id))}>
                  Remove
                </Button>
              </div>
            ))}
            <LinkForm productId={p.id} products={allProducts} />
            <FormError message={a.error} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProductList({ products, canApprove, suppliers }: { products: ProductRowView[]; canApprove: boolean; suppliers: { id: string; name: string }[] }) {
  const [q, setQ] = React.useState("");
  const [cat, setCat] = React.useState("");
  const all = React.useMemo(() => products.map((p) => ({ id: p.id, label: `${p.manufacturer} ${p.model}`, category: p.category })), [products]);
  const shown = products.filter((p) => (!cat || p.category === cat) && (!q || `${p.manufacturer} ${p.family ?? ""} ${p.model}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div className="flex flex-wrap gap-2 px-4 py-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search brand or model" className="h-8 w-56 text-xs" aria-label="Search products" />
        <Select value={cat} onChange={(e) => setCat(e.target.value)} className="h-8 w-40 text-xs" aria-label="Category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <span className="self-center text-xs text-gray-500">{shown.length} shown</span>
      </div>
      {shown.map((p) => (
        <ProductRowItem key={p.id} p={p} canApprove={canApprove} suppliers={suppliers} allProducts={all} />
      ))}
    </>
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
  isDefault: boolean;
  listings: number;
};

export type RouteView = { id: string; brand: string; supplierId: string; supplier: string; rank: number; market: string; status: KnowledgeStatus; notes: string | null };

const PRICE_SOURCES: [string, string][] = [
  ["manual", "Manual entry"],
  ["csv", "CSV / price-list import"],
  ["authenticated_web", "Authenticated web catalogue"],
  ["public_plus_trade", "Public catalogue + trade login"],
  ["api", "Supplier API"],
  ["poa", "POA / manual enquiry"],
];

function CsvImport({ supplierId }: { supplierId: string }) {
  const [text, setText] = React.useState("");
  const [trade, setTrade] = React.useState(false);
  const a = useAction();
  return (
    <div className="space-y-1 sm:col-span-4" data-testid="csv-import">
      <p className="text-xs text-gray-600">
        Import a price list (CSV with a header row: SKU or Model, Manufacturer, Cost ex GST or Cost inc GST, Stock, URL, POA). Prices are recorded against products already in
        the catalogue, unapproved; changes over the review threshold are held. Prepared quotes are not touched.
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-16 flex-1 font-mono text-xs" placeholder="SKU,Manufacturer,Model,Cost ex GST,Stock" aria-label="CSV" />
        <input
          type="file"
          accept=".csv,text/csv"
          className="text-xs"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
          }}
        />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={trade} onChange={(e) => setTrade(e.target.checked)} /> These are Get Secure trade (account) prices, not retail
        </label>
        <Button
          size="sm"
          variant="secondary"
          disabled={a.pending || !text.trim() || !trade}
          onClick={() =>
            a.run(
              () => importSupplierCsvAction(supplierId, text, trade),
              (d) =>
                `${d.recorded} price(s) recorded, ${d.held} held for review, ${d.poa} POA.${d.unmatched.length ? ` Not in the catalogue: ${d.unmatched.slice(0, 8).join(", ")}${d.unmatched.length > 8 ? "…" : ""}.` : ""}${d.errors.length ? ` ${d.errors.length} row(s) skipped.` : ""}`,
            )
          }
        >
          Import prices
        </Button>
      </div>
      {a.msg ? <p className="text-xs text-green-700">{a.msg}</p> : null}
      <FormError message={a.error} />
    </div>
  );
}

function RouteEditor({ r, suppliers, canApprove }: { r: RouteView | null; suppliers: SupplierView[]; canApprove: boolean }) {
  const [v, setV] = React.useState({
    brand: r?.brand ?? "",
    supplierId: r?.supplierId ?? suppliers[0]?.id ?? "",
    rank: String(r?.rank ?? 1),
    market: r?.market ?? "both",
    status: (r?.status ?? "getsecure_provisional") as KnowledgeStatus,
    notes: r?.notes ?? "",
  });
  const a = useAction();
  const set = (k: keyof typeof v, val: string) => setV((cur) => ({ ...cur, [k]: val }));
  return (
    <div className="grid grid-cols-2 items-center gap-2 border-t border-gray-100 px-4 py-2 text-xs sm:grid-cols-[10rem_12rem_4rem_8rem_12rem_1fr_auto]" data-testid="route-row">
      <Input value={v.brand} onChange={(e) => set("brand", e.target.value)} placeholder="Brand / family" className="h-8 text-xs" aria-label="Brand" />
      <Select value={v.supplierId} onChange={(e) => set("supplierId", e.target.value)} className="h-8 text-xs" aria-label="Supplier">
        {suppliers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <Input value={v.rank} onChange={(e) => set("rank", e.target.value)} type="number" className="h-8 text-xs" aria-label="Rank" title="1 = preferred" />
      <Select value={v.market} onChange={(e) => set("market", e.target.value)} className="h-8 text-xs" aria-label="Market">
        <option value="both">Any job</option>
        <option value="residential">Residential</option>
        <option value="commercial">Commercial</option>
      </Select>
      <StatusSelect id={`rs-${r?.id ?? "new"}`} value={v.status} onChange={(x) => set("status", x)} canApprove={canApprove} />
      <Input value={v.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Notes" className="h-8 text-xs" />
      <span className="flex gap-1">
        <Button size="sm" variant="secondary" disabled={a.pending || !v.brand} onClick={() => a.run(() => saveRouteAction({ id: r?.id ?? null, ...v, rank: Number(v.rank), notes: v.notes || null }), () => "Saved.")}>
          {r ? "Save" : "Add route"}
        </Button>
        {r ? (
          <Button size="sm" variant="ghost" className="text-red-600" disabled={a.pending} onClick={() => a.run(() => deleteRouteAction(r.id))}>
            Remove
          </Button>
        ) : null}
      </span>
      {a.msg || a.error ? (
        <span className="col-span-full">
          {a.msg ? <span className="text-green-700">{a.msg}</span> : null}
          <FormError message={a.error} />
        </span>
      ) : null}
    </div>
  );
}

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
    isDefault: s?.isDefault ?? false,
  });
  const [user, setUser] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const a = useAction();
  const set = (k: keyof typeof v, val: string | boolean) => setV((cur) => ({ ...cur, [k]: val }));
  const id = s?.id ?? "new";
  return (
    <div className="grid gap-2 border-t border-gray-100 p-4 text-sm sm:grid-cols-4" data-testid="supplier-form">
      {s ? (
        <p className="text-xs text-gray-500 sm:col-span-4">
          {s.listings} listing(s){s.lastPriceSyncAt ? ` · last import ${s.lastPriceSyncAt}` : ""}
          {s.isDefault ? " · default supplier" : ""}
        </p>
      ) : null}
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
          {PRICE_SOURCES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Integration / login method" htmlFor={`si-${id}`}>
        <Input id={`si-${id}`} value={v.integrationMethod} onChange={(e) => set("integrationMethod", e.target.value)} />
      </Field>
      <Field label="Brands (comma separated)" htmlFor={`sb-${id}`}>
        <Input id={`sb-${id}`} value={v.brands} onChange={(e) => set("brands", e.target.value)} />
      </Field>
      <Field label="Notes" htmlFor={`snn-${id}`} className="sm:col-span-3">
        <Input id={`snn-${id}`} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 pt-5 text-sm">
        <input type="checkbox" checked={v.isDefault} onChange={(e) => set("isDefault", e.target.checked)} /> Default supplier
      </label>
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
      {s ? <CsvImport supplierId={s.id} /> : null}
    </div>
  );
}

// ---------- packages ----------

export type PackageView = {
  id: string;
  key: string | null;
  name: string;
  propertyType: string;
  installType: "new" | "upgrade_ip";
  cameraCount: number | null;
  storeyType: string | null;
  estimatedHours: number | null;
  labourRate: number | null;
  allowanceExGst: number | null;
  materialCostExGst: number | null;
  materialsPackageId: string | null;
  conduitIncluded: boolean;
  conduitAllowanceExGst: number | null;
  complexityAllowanceExGst: number | null;
  includedMaterials: string[];
  assumptions: string[];
  exclusions: string[];
  version: number;
  status: KnowledgeStatus;
  notes: string | null;
};

export type MaterialsView = {
  id: string;
  name: string;
  customerDescription: string;
  items: { description: string; quantity?: string | null; costExGst?: number | null }[];
  costExGst: number | null;
  sellExGst: number | null;
  version: number;
  status: KnowledgeStatus;
  notes: string | null;
};

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function PackageForm({ p, canApprove, materials }: { p: PackageView | null; canApprove: boolean; materials: MaterialsView[] }) {
  const [v, setV] = React.useState({
    key: p?.key ?? "",
    name: p?.name ?? "",
    propertyType: p?.propertyType ?? "residential",
    cameraCount: p?.cameraCount != null ? String(p.cameraCount) : "4",
    installType: p?.installType ?? "new",
    storeyType: p?.storeyType ?? "single",
    estimatedHours: p?.estimatedHours != null ? String(p.estimatedHours) : "",
    labourRate: p?.labourRate != null ? String(p.labourRate) : "",
    allowanceExGst: p?.allowanceExGst != null ? String(p.allowanceExGst) : "",
    materialCostExGst: p?.materialCostExGst != null ? String(p.materialCostExGst) : "",
    materialsPackageId: p?.materialsPackageId ?? materials[0]?.id ?? "",
    conduitIncluded: p?.conduitIncluded ?? false,
    conduitAllowanceExGst: p?.conduitAllowanceExGst != null ? String(p.conduitAllowanceExGst) : "",
    complexityAllowanceExGst: p?.complexityAllowanceExGst != null ? String(p.complexityAllowanceExGst) : "",
    includedMaterials: (p?.includedMaterials ?? []).join(", "),
    assumptions: (p?.assumptions ?? []).join(", "),
    exclusions: (p?.exclusions ?? []).join(", "),
    status: (p?.status ?? "getsecure_provisional") as KnowledgeStatus,
    notes: p?.notes ?? "",
  });
  const a = useAction();
  const set = (k: keyof typeof v, val: string | boolean) => setV((cur) => ({ ...cur, [k]: val }));
  const id = p?.id ?? "new";
  const n = (x: string) => numOrNull(x);
  const hours = n(v.estimatedHours);
  const rate = n(v.labourRate) ?? (v.propertyType === "commercial" ? 110 : 95);
  const parts = [hours != null ? hours * rate : null, n(v.materialCostExGst), v.conduitIncluded ? n(v.conduitAllowanceExGst) : 0, n(v.complexityAllowanceExGst)];
  const internal = parts.every((x) => x != null) ? (parts as number[]).reduce((s, x) => s + x, 0) : null;
  const sell = n(v.allowanceExGst);
  const missing = [
    hours == null && "labour hours",
    n(v.materialCostExGst) == null && "standard material cost",
    v.conduitIncluded && n(v.conduitAllowanceExGst) == null && "conduit allowance",
    n(v.complexityAllowanceExGst) == null && "complexity allowance",
    sell == null && "customer sell allowance",
  ].filter(Boolean) as string[];
  return (
    <div className="grid gap-2 border-t border-gray-100 p-4 text-sm sm:grid-cols-4" data-testid="package-form">
      <Field label="Key" htmlFor={`kk-${id}`} hint="Exact package key">
        <Input id={`kk-${id}`} value={v.key} onChange={(e) => set("key", e.target.value.toUpperCase())} placeholder="RES_CCTV_SINGLE_4" />
      </Field>
      <Field label="Name" htmlFor={`kn-${id}`}>
        <Input id={`kn-${id}`} value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="Residential CCTV, single storey, 4 cameras" />
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
      <Field label="Exact camera count" htmlFor={`kc-${id}`}>
        <Input id={`kc-${id}`} type="number" value={v.cameraCount} onChange={(e) => set("cameraCount", e.target.value)} />
      </Field>
      <Field label="Installation type" htmlFor={`kit-${id}`}>
        <Select id={`kit-${id}`} value={v.installType} onChange={(e) => set("installType", e.target.value)}>
          <option value="new">New installation</option>
          <option value="upgrade_ip">IP upgrade (existing Cat5e/Cat6 reused)</option>
        </Select>
      </Field>
      {v.installType === "new" ? (
        <Field label="Storey type" htmlFor={`kst-${id}`}>
          <Select id={`kst-${id}`} value={v.storeyType} onChange={(e) => set("storeyType", e.target.value)}>
            <option value="single">Single storey</option>
            <option value="double">Double storey</option>
          </Select>
        </Field>
      ) : null}
      <Field label="Expected labour hours" htmlFor={`kh-${id}`}>
        <Input id={`kh-${id}`} type="number" value={v.estimatedHours} onChange={(e) => set("estimatedHours", e.target.value)} placeholder="Not set" />
      </Field>
      <Field label="Internal labour rate ($/h)" htmlFor={`kr-${id}`} hint="Blank uses the policy rate">
        <Input id={`kr-${id}`} type="number" value={v.labourRate} onChange={(e) => set("labourRate", e.target.value)} placeholder={v.propertyType === "commercial" ? "110" : "95"} />
      </Field>
      <Field label="Standard material cost, ex GST ($)" htmlFor={`kmc-${id}`} hint="Internal">
        <Input id={`kmc-${id}`} type="number" value={v.materialCostExGst} onChange={(e) => set("materialCostExGst", e.target.value)} placeholder="Not set" />
      </Field>
      <div className="space-y-1 pt-5">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.conduitIncluded} onChange={(e) => set("conduitIncluded", e.target.checked)} /> Conduit allowance applies
        </label>
      </div>
      <Field label="Conduit allowance, ex GST ($)" htmlFor={`kca-${id}`} hint="Internal">
        <Input id={`kca-${id}`} type="number" value={v.conduitAllowanceExGst} onChange={(e) => set("conduitAllowanceExGst", e.target.value)} placeholder="Not set" disabled={!v.conduitIncluded} />
      </Field>
      <Field label="Complexity allowance, ex GST ($)" htmlFor={`kx-${id}`} hint="Internal; 0 if none">
        <Input id={`kx-${id}`} type="number" value={v.complexityAllowanceExGst} onChange={(e) => set("complexityAllowanceExGst", e.target.value)} placeholder="Not set" />
      </Field>
      <Field label="Customer sell allowance, ex GST ($)" htmlFor={`ka-${id}`} hint="Installation incl. cabling and standard materials">
        <Input id={`ka-${id}`} type="number" value={v.allowanceExGst} onChange={(e) => set("allowanceExGst", e.target.value)} placeholder="Not set" />
      </Field>
      <Field label="Standard materials contents" htmlFor={`km-${id}`}>
        <Select id={`km-${id}`} value={v.materialsPackageId} onChange={(e) => set("materialsPackageId", e.target.value)}>
          <option value="">Default</option>
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-700 sm:col-span-2" data-testid="package-totals">
        Internal cost: {internal != null ? `$${internal.toFixed(2)}` : "—"} · Sell: {sell != null ? `$${sell.toFixed(2)}` : "—"}
        {internal != null && sell != null ? ` · Installation margin $${(sell - internal).toFixed(2)}` : ""}
        {missing.length ? <span className="block text-amber-700">Not set: {missing.join(", ")}.</span> : null}
      </div>
      <Field label="Assumptions" htmlFor={`kas-${id}`} className="sm:col-span-2">
        <Input id={`kas-${id}`} value={v.assumptions} onChange={(e) => set("assumptions", e.target.value)} />
      </Field>
      <Field label="Exclusions" htmlFor={`kex-${id}`} className="sm:col-span-2">
        <Input id={`kex-${id}`} value={v.exclusions} onChange={(e) => set("exclusions", e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
        <Button
          size="sm"
          variant="secondary"
          disabled={a.pending || !v.name}
          onClick={() =>
            a.run(
              () =>
                savePackageAction({
                  id: p?.id ?? null,
                  key: v.key || null,
                  name: v.name,
                  propertyType: v.propertyType,
                  cameraCount: Number(v.cameraCount),
                  installType: v.installType,
                  storeyType: v.installType === "upgrade_ip" ? null : v.storeyType,
                  estimatedHours: n(v.estimatedHours),
                  labourRate: n(v.labourRate),
                  allowanceExGst: n(v.allowanceExGst),
                  materialCostExGst: n(v.materialCostExGst),
                  materialsPackageId: v.materialsPackageId || null,
                  conduitIncluded: v.conduitIncluded,
                  conduitAllowanceExGst: v.conduitIncluded ? n(v.conduitAllowanceExGst) : null,
                  complexityAllowanceExGst: n(v.complexityAllowanceExGst),
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

function MaterialsForm({ m, canApprove }: { m: MaterialsView; canApprove: boolean }) {
  const [v, setV] = React.useState({
    name: m.name,
    customerDescription: m.customerDescription,
    items: m.items.map((i) => `${i.description}${i.costExGst != null ? ` | ${i.costExGst}` : ""}`).join("\n"),
    costExGst: m.costExGst != null ? String(m.costExGst) : "",
    sellExGst: m.sellExGst != null ? String(m.sellExGst) : "",
    status: m.status,
    notes: m.notes ?? "",
  });
  const a = useAction();
  const set = (k: keyof typeof v, val: string) => setV((cur) => ({ ...cur, [k]: val }));
  const items = v.items
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [d, c] = l.split("|").map((x) => x.trim());
      return { description: d, costExGst: c ? Number(c) : null };
    });
  return (
    <div className="grid gap-2 border-t border-gray-100 p-4 text-sm sm:grid-cols-4" data-testid="materials-form">
      <Field label="Name" htmlFor={`mn-${m.id}`}>
        <Input id={`mn-${m.id}`} value={v.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Shown to the customer as" htmlFor={`mc-${m.id}`}>
        <Input id={`mc-${m.id}`} value={v.customerDescription} onChange={(e) => set("customerDescription", e.target.value)} />
      </Field>
      <p className="text-xs text-gray-500 sm:col-span-2">
        The cost of these materials is entered on each installation package (it depends on the camera count); the customer sees them inside the installation line.
      </p>
      <Field label="Contents (one per line)" htmlFor={`mi-${m.id}`} className="sm:col-span-3">
        <Textarea id={`mi-${m.id}`} value={v.items} onChange={(e) => set("items", e.target.value)} className="min-h-28 text-xs" />
      </Field>
      <div className="space-y-2">
        <Field label="Status" htmlFor={`mst-${m.id}`}>
          <StatusSelect id={`mst-${m.id}`} value={v.status} onChange={(x) => set("status", x)} canApprove={canApprove} />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={a.pending || !v.name}
          onClick={() =>
            a.run(
              () =>
                saveMaterialsPackageAction({
                  id: m.id,
                  name: v.name,
                  customerDescription: v.customerDescription,
                  items,
                  costExGst: numOrNull(v.costExGst),
                  sellExGst: numOrNull(v.sellExGst),
                  status: v.status,
                  notes: v.notes || null,
                }),
              () => "Saved.",
            )
          }
        >
          Save (becomes v{m.version + 1})
        </Button>
        {a.msg ? <p className="text-xs text-green-700">{a.msg}</p> : null}
        <FormError message={a.error} />
      </div>
    </div>
  );
}

// ---------- page ----------

const TABS = [
  { key: "policies", label: "Rules" },
  { key: "products", label: "Products & prices" },
  { key: "suppliers", label: "Suppliers & routing" },
  { key: "pricing", label: "Supplier pricing" },
  { key: "kits", label: "Kits" },
  { key: "packages", label: "Installation & materials" },
] as const;

export function BrainSettings({
  tab,
  canApprove,
  policies,
  products,
  suppliers,
  routes,
  packages,
  materials,
  kits,
  kitProducts,
  connectors,
  pricingSettings,
}: {
  tab: string;
  canApprove: boolean;
  policies: PolicyRow[];
  products: ProductRowView[];
  suppliers: SupplierView[];
  routes: RouteView[];
  packages: PackageView[];
  materials: MaterialsView[];
  kits: KitView[];
  kitProducts: KitProductOption[];
  connectors: ConnectorView[];
  pricingSettings: SupplierPricingSettings;
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
        <Link href="/settings/brain/packages" className="-mb-px border-b-2 border-transparent px-3 py-2 text-gray-600 hover:text-gray-900" data-testid="brain-packages-tab">
          Proposed packages
        </Link>
        <Link href="/settings/brain/research" className="-mb-px border-b-2 border-transparent px-3 py-2 text-gray-600 hover:text-gray-900" data-testid="brain-research-tab">
          Research
        </Link>
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
          <ProductList products={products} canApprove={canApprove} suppliers={suppliers.filter((s) => s.status !== "deprecated").map((s) => ({ id: s.id, name: s.name }))} />
        </Card>
      ) : null}

      {tab === "suppliers" ? (
        <>
          <Card>
            <CardHeader title={`Brand routing · ${routes.length}`} />
            <p className="px-4 pt-2 text-xs text-gray-500">
              Which supplier each brand is bought from, in order (1 = preferred). The assessment uses the preferred supplier&apos;s approved price, then the next route, then the
              default supplier. Brands with no route use the default supplier.
            </p>
            {routes.map((r) => (
              <RouteEditor key={r.id} r={r} suppliers={suppliers} canApprove={canApprove} />
            ))}
            <RouteEditor r={null} suppliers={suppliers} canApprove={canApprove} />
          </Card>
          <Card>
            <CardHeader title="Suppliers" />
            <p className="px-4 pt-2 text-xs text-gray-500">Logins are stored encrypted and are never shown again or given to any agent.</p>
            {suppliers.map((s) => (
              <SupplierForm key={s.id} s={s} canApprove={canApprove} />
            ))}
            <SupplierForm s={null} canApprove={canApprove} />
          </Card>
        </>
      ) : null}

      {tab === "pricing" ? <SupplierPricing connectors={connectors} canApprove={canApprove} settings={pricingSettings} /> : null}

      {tab === "kits" ? <KitSettings kits={kits} products={kitProducts} canApprove={canApprove} /> : null}

      {tab === "packages" ? (
        <>
          <Card>
            <CardHeader title="Installation packages" />
            <p className="px-4 pt-2 text-xs text-gray-500">
              One package per exact camera count and storey type (RES_CCTV_SINGLE_4 …); jobs with any other count are custom installations. Labour cost is hours × the
              internal rate; with the material cost and allowances it is the internal cost. The customer pays the sell allowance. Until every value is entered, installation
              shows as unpriced.
            </p>
            {packages.map((p) => (
              <PackageForm key={p.id} p={p} canApprove={canApprove} materials={materials} />
            ))}
            <PackageForm p={null} canApprove={canApprove} materials={materials} />
          </Card>
          <Card>
            <CardHeader title="Standard materials" />
            <p className="px-4 pt-2 text-xs text-gray-500">Customers see one line; approvers see the contents and internal cost.</p>
            {materials.map((m) => (
              <MaterialsForm key={m.id} m={m} canApprove={canApprove} />
            ))}
          </Card>
        </>
      ) : null}
    </div>
  );
}
