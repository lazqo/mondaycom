"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  XCircle,
} from "lucide-react";
import { Badge, Card, CardHeader } from "@/components/ui";
import type { DecisionPacket, Level } from "@/lib/brain/types";
import { KNOWLEDGE_STATUS_LABELS } from "@/lib/brain/types";
import { cn } from "@/lib/utils";

const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LEVEL: Record<Level, string> = {
  high: "bg-green-100 text-green-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-red-100 text-red-800",
};
const label = (s: string) => s.replace(/_/g, " ");
const sumSell = (lines: { unitSellExGst: number | null; quantity: number; internalOnly?: boolean }[]) =>
  lines.some((l) => l.unitSellExGst == null && !l.internalOnly) ? null : lines.reduce((t, l) => t + (l.internalOnly ? 0 : (l.unitSellExGst ?? 0) * l.quantity), 0);

function Section({
  title,
  children,
  defaultOpen = true,
  testid,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  testid?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section
      className="border-t border-gray-100 first:border-t-0"
      data-testid={testid}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-sm font-semibold text-gray-900 hover:bg-gray-50"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400" />
        )}
        {title}
      </button>
      {open ? (
        <div className="space-y-2 px-4 pb-4 text-sm text-gray-800">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function List({ items, empty }: { items: string[]; empty?: string }) {
  if (!items.length)
    return empty ? <p className="text-gray-500">{empty}</p> : null;
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

export function PacketView({
  packet,
  createdAt,
}: {
  packet: DecisionPacket;
  createdAt: string | null;
}) {
  const p = packet;
  const c = p.costing;
  return (
    <Card data-testid="decision-packet">
      <CardHeader
        title="Decision packet"
        action={
          <span className="flex items-center gap-2 text-xs text-gray-500">
            {createdAt ? `Run ${createdAt}` : null}
            <Badge className={LEVEL[p.confidence.overall]}>
              Overall confidence: {p.confidence.overall}
            </Badge>
          </span>
        }
      />

      {p.readiness ? (
        <Section title={p.readiness.ready ? "Ready: fully priced from approved inputs" : c.complete ? "Priced, but not all inputs are approved yet" : "Not fully priced yet"} testid="packet-readiness">
          <ul className="space-y-1 text-xs">
            {p.readiness.items.map((i) => (
              <li key={i.key} className="flex gap-1.5" data-testid="readiness-item">
                {i.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
                <span>
                  <strong className={i.ok ? "text-gray-800" : "text-red-700"}>{i.label}</strong>
                  <span className="text-gray-600"> · {i.detail}</span>
                  {!i.ok && i.fix ? <span className="block text-gray-500">Fix: {i.fix}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Summary" testid="packet-summary">
        <div className="grid gap-2 sm:grid-cols-2">
          <p>
            <span className="text-gray-500">Site visit: </span>
            <strong data-testid="packet-site-visit">
              {p.siteVisit.required ? "Required" : "Not required"}
            </strong>
            {!p.siteVisit.required
              ? ` (remote quote confidence ${p.siteVisit.remoteQuoteConfidence})`
              : null}
          </p>
          <p>
            <span className="text-gray-500">Tier: </span>
            <strong>
              {p.recommendedTier ??
                (p.propertyType === "commercial"
                  ? "Commercial (requirements-driven)"
                  : "—")}
            </strong>
            {p.alternativeTier ? (
              <span className="text-gray-500">
                {" "}
                · alternative {p.alternativeTier}
              </span>
            ) : null}
          </p>
          <p>
            <span className="text-gray-500">Customer price: </span>
            <strong data-testid="packet-total">
              {c.complete
                ? `${money(c.totalIncGst)} inc GST`
                : "Not fully priced"}
            </strong>
          </p>
          <p>
            <span className="text-gray-500">Next action: </span>
            {p.nextAction}
          </p>
        </div>
        <p className="text-xs text-gray-500">{p.tierReason}</p>
        <List items={p.siteVisit.reasons} />
        <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
          {(["technical", "pricing", "site"] as const).map((k) => (
            <Badge key={k} className={LEVEL[p.confidence[k]]}>
              {k}: {p.confidence[k]}
            </Badge>
          ))}
        </div>
        <List items={p.confidence.reasons} />
      </Section>

      <Section
        title={`Approvals required (${p.approvals.length})`}
        testid="packet-approvals"
      >
        <ul className="space-y-1">
          {p.approvals.map((a) => (
            <li key={a.key} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              {a.description}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={`Requirements and missing information (${p.missing.length} missing)`}
      >
        <List items={p.requirements} />
        {p.missing.length ? (
          <ul className="space-y-1 pt-1">
            {p.missing.map((m) => (
              <li key={m.field} className="flex gap-2">
                <CircleHelp
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    m.importance === "blocks_quote"
                      ? "text-red-500"
                      : m.importance === "affects_price"
                        ? "text-amber-500"
                        : "text-gray-400",
                  )}
                />
                <span>
                  {m.question}{" "}
                  <span className="text-xs text-gray-500">
                    ({label(m.importance)})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {p.tierOptions.length ? (
        <Section title="Tier options" defaultOpen={false}>
          <table className="w-full text-left text-sm">
            <tbody>
              {p.tierOptions.map((t) => (
                <tr key={t.tier} className="border-t border-gray-100">
                  <td className="py-1 font-medium capitalize">{t.tier}</td>
                  <td className="py-1 text-gray-600">
                    {t.cameraModels.join(", ") || "No camera in catalogue"}
                  </td>
                  <td className="py-1 text-right">
                    {t.complete ? money(t.totalIncGst) : "incomplete"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      <Section
        title={`Camera plan (${p.cameras.length})`}
        testid="packet-cameras"
      >
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="py-1">Area</th>
              <th className="py-1">Purpose</th>
              <th className="py-1">Camera</th>
            </tr>
          </thead>
          <tbody>
            {p.cameras.map((cam) => (
              <tr
                key={cam.requirement.id}
                className="border-t border-gray-100 align-top"
              >
                <td className="py-1">{cam.requirement.targetArea}</td>
                <td className="py-1 text-gray-600">
                  {label(cam.requirement.purpose)} ·{" "}
                  {cam.requirement.requiredDetail}
                </td>
                <td className="py-1">
                  {cam.product ? (
                    `${cam.product.resolutionMp} MP ${cam.product.manufacturer} ${cam.product.model}`
                  ) : (
                    <span className="text-red-600">none suitable</span>
                  )}
                  <p className="text-xs text-gray-500">
                    {cam.reasons.join(" ")}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Recorder (NVR)" testid="packet-nvr">
        <p>
          {p.nvr.selected ? (
            <strong>
              {p.nvr.selected.manufacturer} {p.nvr.selected.model},{" "}
              {p.nvr.selected.channels} channels
            </strong>
          ) : (
            <span className="text-red-600">No recorder selected</span>
          )}
          {p.nvr.channelsNeeded ? (
            <span className="text-gray-500">
              {" "}
              · {p.nvr.channelsNeeded} channels needed
              {p.nvr.expansionChannels
                ? ` incl. ${p.nvr.expansionChannels} for expansion`
                : ""}
            </span>
          ) : null}
        </p>
        <List items={p.nvr.notes} />
        {p.nvr.evaluated.map((e) => (
          <div
            key={e.product.id}
            className="rounded border border-gray-100 p-2"
          >
            <p className="flex items-center gap-1.5 font-medium">
              {e.pass ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
              {e.product.manufacturer} {e.product.model}{" "}
              {e.pass ? "passes" : "rejected"}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
              {e.checks.map((ch) => (
                <li key={ch.name} className={!ch.pass ? "text-red-600" : ch.warning ? "font-medium text-amber-700" : ch.unverified ? "text-amber-700" : ""}>
                  {!ch.pass ? "✗" : ch.warning ? "⚠" : ch.unverified ? "?" : "✓"} {ch.name === "bandwidth" ? "design bandwidth" : ch.name === "max_bandwidth" ? "maximum possible bandwidth" : ch.name}: {ch.detail}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {p.interoperability.length ? <List items={p.interoperability} /> : null}
      </Section>

      <Section title="Recording and storage" testid="packet-storage">
        <p>
          {p.recording.mode === "continuous" ? "24/7 continuous" : "Motion"}{" "}
          recording, target {p.recording.storage.retentionTargetDays} days (
          {p.recording.storage.retentionSource === "customer"
            ? "customer's request"
            : "Get Secure standard"}
          )
        </p>
        {p.recording.profile ? (
          <p className="text-xs text-gray-600" data-testid="packet-profile">
            Recording profile: <strong>{p.recording.profile.name}</strong> ({label(p.recording.profile.status)})
            {p.recording.profile.codec ? ` · ${p.recording.profile.codec}` : ""}
            {p.recording.profile.frameRate ? ` · ${p.recording.profile.frameRate} fps` : ""}
            {p.recording.profile.bitrateControl ? ` · ${p.recording.profile.bitrateControl}` : ""}
          </p>
        ) : (
          <p className="text-xs text-red-600">No recording profile: approved recording profile required.</p>
        )}
        {p.recording.designs?.length ? (
          <table className="w-full text-left text-xs" data-testid="packet-designs">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1">Camera</th>
                <th className="py-1 text-right">Design bitrate</th>
                <th className="py-1">Source</th>
                <th className="py-1 text-right">Published max</th>
              </tr>
            </thead>
            <tbody>
              {p.recording.designs.map((d) => (
                <tr key={d.productId} className="border-t border-gray-100">
                  <td className="py-1">
                    {d.model} ({d.resolutionMp} MP)
                  </td>
                  <td className={cn("py-1 text-right", d.designBitrateMbps == null && "text-red-600")}>{d.designBitrateMbps != null ? `${d.designBitrateMbps} Mbps` : "not set"}</td>
                  <td className="py-1 text-gray-600">
                    {d.bitrateSource ?? "—"}
                    {d.designBitrateMbps != null && !d.bitrateApproved ? " (not approved)" : ""}
                  </td>
                  <td className="py-1 text-right text-gray-600">{d.publishedMaxBitrateMbps != null ? `${d.publishedMaxBitrateMbps} Mbps` : "not published"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {p.recording.designBandwidthMbps != null || p.recording.maxPossibleBandwidthMbps != null ? (
          <p className="text-xs text-gray-600">
            Design bandwidth {p.recording.designBandwidthMbps != null ? `${p.recording.designBandwidthMbps.toFixed(1)} Mbps` : "unknown"} · maximum possible configured{" "}
            {p.recording.maxPossibleBandwidthMbps != null ? `${p.recording.maxPossibleBandwidthMbps.toFixed(1)} Mbps` : "unknown"}
          </p>
        ) : null}
        {p.recording.storage.rawGb != null ? (
          <p className="text-xs text-gray-600" data-testid="packet-storage-calc">
            Raw storage {(p.recording.storage.rawGb / 1000).toFixed(2)} TB for {p.recording.storage.retentionTargetDays} days · headroom {p.recording.storage.headroomPct}% · required{" "}
            {p.recording.storage.requiredGb != null ? `${(p.recording.storage.requiredGb / 1000).toFixed(2)} TB` : "—"}
            {p.recording.storage.installedTb != null ? ` · installed ${p.recording.storage.installedTb} TB` : ""}
          </p>
        ) : null}
        <List items={p.recording.storage.notes} />
        <p>
          Recommended:{" "}
          <strong>
            {p.recording.storage.drives
              ? `${p.recording.storage.drives.count} × ${p.recording.storage.drives.product.capacityTb} TB (${p.recording.storage.drives.product.model})`
              : "—"}
          </strong>
          {p.recording.storage.expectedRetentionDays != null
            ? ` · about ${p.recording.storage.expectedRetentionDays} days`
            : ""}{" "}
          ·{" "}
          <Badge
            className={
              p.recording.storage.status === "meets_target"
                ? "bg-green-100 text-green-800"
                : "bg-amber-100 text-amber-800"
            }
          >
            {label(p.recording.storage.status)}
          </Badge>
        </p>
      </Section>

      <Section title="Network">
        <p>
          <strong>{label(p.network.method)}</strong>: {p.network.description}
        </p>
        <List items={p.network.unresolved.map((u) => `Unresolved: ${u}`)} />
        <List
          items={p.network.customerDecisions.map(
            (u) => `Customer decision: ${u}`,
          )}
        />
      </Section>

      <Section title="Installation and materials">
        <p>
          {p.installation.storeys ?? "?"}-storey · complexity{" "}
          {p.installation.complexity}
          {p.installation.conduitRequired ? " · conduit allowance" : ""}
        </p>
        <table className="w-full text-left text-sm">
          <tbody>
            {p.installation.materials.map((m) => (
              <tr key={m.key} className="border-t border-gray-100 align-top">
                <td className="py-1">
                  {m.quantity} × {m.description}
                </td>
                <td className="py-1 text-xs text-gray-600">{m.reason}</td>
                <td className="py-1 text-right text-xs">
                  {m.charged
                    ? "charged"
                    : m.approvalRequired
                      ? "Chris to confirm"
                      : "not charged"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {p.installation.upgrade ? (
          <div className="rounded border border-amber-200 bg-amber-50/50 p-2 text-xs" data-testid="packet-upgrade">
            <p className="font-medium text-gray-800">Upgrade: {p.installation.upgrade.summary}</p>
            <p className="text-gray-600">
              Existing: {label(p.installation.upgrade.existing.systemType)}
              {p.installation.upgrade.existing.cameraCount != null ? `, ${p.installation.upgrade.existing.cameraCount} camera(s)` : ""}
              {p.installation.upgrade.existing.recorder ? `, recorder ${p.installation.upgrade.existing.recorder}` : ""} · cable {label(p.installation.upgrade.existing.cableType)} (
              {label(p.installation.upgrade.existing.cableCondition)}) · positions: {p.installation.upgrade.positions.reuse} reused, {p.installation.upgrade.positions.new} new,{" "}
              {p.installation.upgrade.positions.confirm} to confirm
            </p>
            {p.installation.upgrade.unresolved ? <p className="text-red-700">{p.installation.upgrade.unresolved}</p> : null}
            <List items={[...p.installation.upgrade.decisions.map((d) => `Decision: ${d}`), ...p.installation.upgrade.notes]} />
          </div>
        ) : null}
        <p className="text-xs" data-testid="packet-junction-box">
          <span className="text-gray-500">Junction boxes: </span>
          {p.installation.junctionBoxRecommended ? (
            <strong>recommended</strong>
          ) : (
            <strong>not recommended</strong>
          )}{" "}
          <span className="text-gray-600">
            {p.installation.junctionBoxReason ??
              "— no camera is on a surface the junction-box rule lists (brick/concrete by default); the documented box below is the candidate if Chris wants one."}
          </span>
        </p>
        {p.installation.accessories?.length ? (
          <div data-testid="packet-accessories">
            <p className="text-xs font-semibold text-gray-700">Documented accessories (not charged unless Chris adds them)</p>
            <List items={p.installation.accessories.map((x) => `${x.camera}: ${label(x.kind.replace("camera_", ""))} ${x.product}`)} />
          </div>
        ) : null}
        <div className="rounded border border-gray-100 p-2 text-xs" data-testid="packet-labour">
          {p.labour.package ? (
            <>
              <p className="font-medium text-gray-800">
                Installation package {p.labour.package.key ?? p.labour.package.name}
                {p.labour.package.status !== "getsecure_approved" ? <span className="font-normal text-amber-700"> ({label(p.labour.package.status)})</span> : null}
              </p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
                <dt className="text-gray-500">Labour hours</dt>
                <dd>{p.labour.estimatedHours ?? "not set"}</dd>
                <dt className="text-gray-500">Internal rate</dt>
                <dd>${p.labour.internalRate}/h</dd>
                <dt className="text-gray-500">Labour cost</dt>
                <dd>{money(p.labour.labourCostExGst ?? null)}</dd>
                <dt className="text-gray-500">Material cost</dt>
                <dd>{money(p.labour.materialCostExGst ?? null)}</dd>
                <dt className="text-gray-500">Conduit allowance</dt>
                <dd>{p.labour.conduitCostExGst === 0 ? "n/a" : money(p.labour.conduitCostExGst ?? null)}</dd>
                <dt className="text-gray-500">Complexity allowance</dt>
                <dd>{money(p.labour.complexityCostExGst ?? null)}</dd>
                <dt className="text-gray-500">Customer sell allowance</dt>
                <dd>{money(p.labour.allowanceExGst)}</dd>
              </dl>
            </>
          ) : (
            <p className={p.labour.customInstallation ? "text-red-600" : "text-gray-600"}>{p.labour.customInstallation ? "Custom installation (no exact package)" : "No installation package"} · internal rate ${p.labour.internalRate}/h</p>
          )}
          {p.labour.missing?.length ? <p className="mt-1 text-red-600">Not set: {p.labour.missing.join("; ")}</p> : null}
        </div>
        <List items={p.labour.notes} />
      </Section>

      <Section title="Costing (internal only)" testid="packet-costing">
        {c.lines.length ? (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="py-1">Line</th>
                <th className="py-1">Supplier · price date</th>
                <th className="py-1 text-right">Qty</th>
                <th className="py-1 text-right">Unit cost</th>
                <th className="py-1 text-right">Cost</th>
                <th className="py-1 text-right">Markup</th>
                <th className="py-1 text-right">Unit sell</th>
                <th className="py-1 text-right">Sell</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => (
                <tr
                  key={l.key}
                  className={cn(
                    "border-t border-gray-100",
                    !l.priced && "text-red-600",
                  )}
                >
                  <td className="py-1">
                    {l.customerDescription}
                    {l.detail?.length ? <p className="text-xs text-gray-500">{l.detail.join("; ")}</p> : null}
                    {l.alternatives?.length ? (
                      <p className="text-xs text-gray-500">
                        Alternatives: {l.alternatives.map((a) => `${a.supplier} $${a.costExGst} (${a.freshness}${a.approved ? "" : ", not approved"}${a.stock ? `, stock ${a.stock}` : ""})`).join("; ")}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-1 text-xs text-gray-600">
                    {l.supplier ?? (l.productId ? "no price" : l.internalOnly ? "internal" : "")}
                    {l.supplierSku ? ` ${l.supplierSku}` : ""}
                    {l.stock ? ` · stock ${l.stock}` : ""}
                    {l.freshness ? (
                      <Badge className={cn("ml-1", l.freshness === "current" ? "bg-green-100 text-green-800" : l.freshness === "aging" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800")}>
                        {l.freshness}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="py-1 text-right">{l.quantity}</td>
                  <td className="py-1 text-right">{money(l.unitCostExGst)}</td>
                  <td className="py-1 text-right">{l.unitCostExGst != null ? money(l.unitCostExGst * l.quantity) : "—"}</td>
                  <td className="py-1 text-right">{l.markupPct != null ? `${l.markupPct}%` : "—"}</td>
                  <td className="py-1 text-right">{l.internalOnly ? "in installation" : money(l.unitSellExGst)}</td>
                  <td className="py-1 text-right">{l.internalOnly ? "—" : l.unitSellExGst != null ? money(l.unitSellExGst * l.quantity) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4" data-testid="packet-commercial">
          <dt className="text-gray-500">Hardware cost</dt>
          <dd>{money(c.equipmentCost)}</dd>
          <dt className="text-gray-500">Hardware markup</dt>
          <dd>
            {c.markupPct}% {c.markupSource === "override" ? "(Chris, this quote)" : "(suggested)"}
          </dd>
          <dt className="text-gray-500">Hardware sell</dt>
          <dd>{money(sumSell(c.lines.filter((l) => l.kind === "hardware")))}</dd>
          <dt className="text-gray-500">Installation sell allowance</dt>
          <dd>{money(p.labour.allowanceExGst)}</dd>
          <dt className="text-gray-500">Total internal cost</dt>
          <dd data-testid="packet-total-internal-cost">{money(c.totalInternalCost ?? c.equipmentCost + c.labourCost + c.materialsCost + (c.allowancesCost ?? 0) + c.otherCost)}</dd>
          <dt className="text-gray-500">Materials cost</dt>
          <dd>{money(c.materialsCost)}</dd>
          <dt className="text-gray-500">Labour cost</dt>
          <dd>{money(c.labourCost)}</dd>
          <dt className="text-gray-500">Conduit / complexity</dt>
          <dd>{money(c.allowancesCost ?? 0)}</dd>
          <dt className="text-gray-500">Other cost</dt>
          <dd>{money(c.otherCost)}</dd>
          <dt className="text-gray-500">Subtotal ex GST</dt>
          <dd>{money(c.sellExGst)}</dd>
          <dt className="text-gray-500">GST</dt>
          <dd>{money(c.gst)}</dd>
          <dt className="text-gray-500">Total inc GST</dt>
          <dd className="font-semibold">{money(c.totalIncGst)}</dd>
          <dt className="text-gray-500">Gross profit</dt>
          <dd>{c.complete ? money(c.grossProfit) : "— until fully priced"}</dd>
          <dt className="text-gray-500">Gross margin</dt>
          <dd>{c.complete && c.grossMarginPct != null ? `${c.grossMarginPct}%` : "— until fully priced"}</dd>
        </dl>
        <p className="text-xs text-gray-600">{c.markupLogic}</p>
        <List items={c.unpriced.map((u) => `Unpriced: ${u}`)} />
        {c.refreshRequired?.length ? (
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-800" data-testid="packet-refresh">
            Refresh supplier price before final quote approval: {c.refreshRequired.map((r) => `${r.model}${r.supplier ? ` (${r.supplier}, ${r.freshness})` : ""}`).join("; ")}.
          </p>
        ) : null}
        {c.kit ? (
          <p className="text-xs text-gray-600">
            Kit used: {c.kit.model} ({c.kit.components.join(", ")}), saving {money(c.kit.savingExGst)} ex GST on buying the parts separately.
          </p>
        ) : null}
      </Section>

      {p.privacy ? (
        <Section title="Privacy (commercial)">
          <table className="w-full text-left text-sm">
            <tbody>
              {p.privacy.checklist.map((r) => (
                <tr key={r.item} className="border-t border-gray-100">
                  <td className="py-1 text-gray-500">{r.item}</td>
                  <td className="py-1">
                    {r.answer ?? (
                      <span className="text-amber-700">to capture</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Audio recording: {p.privacy.audioRecording ? "on" : "off"}</p>
          <List items={p.privacy.flags} />
        </Section>
      ) : null}

      <Section title="Sales read" testid="packet-sales">
        <p>
          Intent <strong>{label(p.sales.intent)}</strong> · concern{" "}
          <strong>{label(p.sales.primaryConcern)}</strong> · stage{" "}
          <strong>{label(p.sales.stage)}</strong> · recommend{" "}
          <strong>{label(p.sales.recommendedAction)}</strong> (
          {label(p.sales.responseStyle)})
        </p>
        <List items={p.sales.notes} />
        {p.sales.objectionChecklist ? (
          <table className="w-full text-left text-sm">
            <tbody>
              {p.sales.objectionChecklist.map((r) => (
                <tr key={r.item} className="border-t border-gray-100">
                  <td className="py-1 text-gray-500">{r.item}</td>
                  <td className="py-1">{r.ours}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>

      <Section title="Assumptions, exclusions, risks" defaultOpen={false}>
        <p className="font-medium">Assumptions</p>
        <List items={p.assumptions} empty="None" />
        <p className="font-medium">Exclusions</p>
        <List items={p.exclusions} empty="None" />
        <p className="font-medium">Risks</p>
        <List items={p.risks} empty="None" />
        <p className="font-medium">Unresolved</p>
        <List items={p.unresolved} empty="None" />
      </Section>

      <Section
        title={`Rules not yet approved (${p.provisionalPolicies.length})`}
        defaultOpen={false}
      >
        <ul className="space-y-0.5">
          {p.provisionalPolicies.map((x) => (
            <li key={x.key}>
              {x.key}:{" "}
              <code className="text-xs">{JSON.stringify(x.value)}</code>{" "}
              <span className="text-xs text-gray-500">
                ({KNOWLEDGE_STATUS_LABELS[x.status]})
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </Card>
  );
}
