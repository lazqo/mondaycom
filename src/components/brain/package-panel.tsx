"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { decidePackageAction, detectPackagePatternsAction } from "@/actions/packages";
import { Button, Input, Select } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";

function useAct() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  const act = (fn: () => Promise<ActionResult<unknown>>, after?: (r: ActionResult<unknown>) => void) =>
    startTransition(async () => {
      setErr(null);
      const res = await fn();
      if (!res.ok) return setErr(res.error);
      after?.(res);
      router.refresh();
    });
  return { pending, err, act };
}

export type ProductOption = { id: string; label: string; category: string };
type Component = { role: string; productId: string; quantity: number; perCamera: boolean };

const ROLE_CATEGORY: Record<string, string | null> = { camera: "camera", nvr: "nvr", hdd: "hdd", accessory: null };

/** Approve, edit and approve, or reject one candidate package. */
export function PackageDecision({ id, initial, products, canApprove }: { id: string; initial: { name: string; key: string | null; tier: string | null; cameraCount: number | null; components: Component[] }; products: ProductOption[]; canApprove: boolean }) {
  const { pending, err, act } = useAct();
  const [mode, setMode] = React.useState<"view" | "edit" | "reject">("view");
  const [name, setName] = React.useState(initial.name);
  const [key, setKey] = React.useState(initial.key ?? "");
  const [tier, setTier] = React.useState(initial.tier ?? "");
  const [count, setCount] = React.useState(String(initial.cameraCount ?? ""));
  const [comps, setComps] = React.useState<Component[]>(initial.components);
  const [note, setNote] = React.useState("");
  if (!canApprove) return <p className="text-xs text-gray-500">Waiting for Chris to approve, edit or reject.</p>;
  const edits = () => ({
    name,
    key: key.trim() || null,
    tier: tier || null,
    camera_count: Number(count) || undefined,
    components: comps.map((c) => ({ role: c.role, product_id: c.productId, quantity: c.quantity, per_camera: c.perCamera })),
  });
  return (
    <div className="space-y-2">
      {mode === "edit" ? (
        <div className="space-y-2 rounded-md border border-gray-200 p-3" data-testid={`package-edit-${id}`}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key (optional)" aria-label="Key" />
            <Select value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier">
              <option value="">Any tier</option>
              {["good", "better", "best", "premium"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Input value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" aria-label="Camera count" placeholder="Cameras" />
          </div>
          {comps.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-20 font-medium text-gray-700">{c.role}</span>
              <Select className="min-w-56 flex-1" value={c.productId} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))} aria-label={`${c.role} product`}>
                {products
                  .filter((p) => !ROLE_CATEGORY[c.role] || p.category === ROLE_CATEGORY[c.role])
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </Select>
              <Input className="w-20" value={String(c.quantity)} inputMode="numeric" onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) || 1 } : x)))} aria-label={`${c.role} quantity`} />
              {c.role === "accessory" ? (
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={c.perCamera} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, perCamera: e.target.checked } : x)))} /> per camera
                </label>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setComps(comps.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setComps([...comps, { role: "accessory", productId: products.find((p) => !["camera", "nvr", "hdd"].includes(p.category))?.id ?? products[0]?.id ?? "", quantity: 1, perCamera: true }])}>
              Add accessory
            </Button>
            <Button size="sm" disabled={pending} data-testid={`package-save-approve-${id}`} onClick={() => act(() => decidePackageAction(id, "approve", edits(), note))}>
              Save and approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "reject" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-64 flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why not (Hermes learns from this)" aria-label="Reason" />
          <Button size="sm" variant="secondary" disabled={pending} data-testid={`package-confirm-reject-${id}`} onClick={() => act(() => decidePackageAction(id, "reject", null, note))}>
            Reject
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending} data-testid={`package-approve-${id}`} onClick={() => act(() => decidePackageAction(id, "approve", null, ""))}>
            Approve
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} data-testid={`package-edit-button-${id}`} onClick={() => setMode("edit")}>
            Edit and approve
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} data-testid={`package-reject-${id}`} onClick={() => setMode("reject")}>
            Reject
          </Button>
        </div>
      )}
      {err ? <p className="text-xs text-red-600">{err}</p> : null}
    </div>
  );
}

export function DetectPatternsButton() {
  const { pending, err, act } = useAct();
  const [note, setNote] = React.useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        data-testid="detect-patterns"
        onClick={() =>
          act(
            () => detectPackagePatternsAction(),
            (r) => {
              const n = (r as { data?: { proposed: number } }).data?.proposed ?? 0;
              setNote(n ? `${n} new candidate${n === 1 ? "" : "s"} proposed.` : "No new repeated configurations.");
            },
          )
        }
      >
        {pending ? "Looking…" : "Look for repeated configurations"}
      </Button>
      {note ? <span className="text-xs text-gray-600">{note}</span> : null}
      {err ? <span className="text-xs text-red-600">{err}</span> : null}
    </span>
  );
}
