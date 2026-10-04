import Link from "next/link";
import { Badge } from "@/components/ui";
import type { Inspection, InspectorActionRow } from "@/db/schema";
import type { HermesResult } from "@/lib/hermes/contract";
import { ACTION_LABELS, FACT_LABELS, HERMES_ACTION_LABELS } from "@/lib/inspector/labels";
import type { Check, Validation } from "@/lib/inspector/validate";
import type { ActionType, FactKey, Understanding } from "@/lib/inspector/types";
import { ActionStatus } from "./views";

type StoredValidation = Pick<Validation, "hard" | "business" | "advisories" | "rejectedFacts" | "headline"> & { fallback?: { hermesStatus: string; error: string | null } };

export function EngineBadge({ engine }: { engine: string }) {
  if (engine === "hermes") return <Badge className="bg-[#037f4c] text-white">Hermes</Badge>;
  if (engine === "fallback") return <Badge className="bg-[#fdab3d] text-white">Fallback (Hermes unavailable)</Badge>;
  return <Badge className="bg-gray-200 text-gray-700">Rules (before Hermes)</Badge>;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function CheckList({ title, items, tone }: { title: string; items: Check[]; tone: string }) {
  if (!items.length) return null;
  return (
    <div>
      <p className={`text-xs font-semibold ${tone}`}>{title}</p>
      <ul className="mt-0.5 space-y-0.5 text-xs text-gray-700">
        {items.map((c, i) => (
          <li key={i}>
            {c.message}
            {c.effect ? <span className="text-gray-500"> → {c.effect.replace(/_/g, " ").toLowerCase()}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Hermes as the main result: what it understood, what it recommended and how sure it was, and what
 * the validator and the Business Brain did with that. The old rules' reading is shown last, small,
 * for comparison only.
 */
export function HermesView({ inspection, actions, compact = false }: { inspection: Inspection; actions: InspectorActionRow[]; compact?: boolean }) {
  const h = inspection.hermes as unknown as HermesResult | null;
  const u = inspection.understanding as unknown as Understanding;
  const v = (inspection.validation ?? null) as unknown as StoredValidation | null;
  const rules = inspection.rulesView as { primaryIntent?: string; firstAction?: string | null; summary?: string } | null;
  const blocked = actions.filter((a) => a.status === "blocked");
  const brain = actions.find((a) => a.type === "RUN_BUSINESS_BRAIN");
  const brainResult = brain?.result as { complete?: boolean; unpriced?: string[]; siteVisitRequired?: boolean; siteVisitReasons?: string[] } | null | undefined;
  const blockingMissing = u.missing.filter((m) => m.blocking);

  return (
    <div className="space-y-2 text-sm" data-testid="hermes-view">
      <p className="flex flex-wrap items-center gap-2">
        <EngineBadge engine={inspection.engine} />
        <span className="font-medium text-gray-900">{inspection.summary}</span>
      </p>

      {h ? (
        <div className="rounded-md bg-gray-50 px-3 py-2" data-testid="hermes-recommendation">
          <p>
            <span className="text-gray-500">Recommended next action: </span>
            <span className="font-semibold text-gray-900">{HERMES_ACTION_LABELS[h.recommended_action] ?? h.recommended_action}</span>
            <span className="text-gray-500"> · Confidence: </span>
            <span className="font-medium text-gray-900">{pct(h.confidence)}</span>
          </p>
          <p className="text-gray-700">
            <span className="text-gray-500">Reason: </span>
            {h.reason}
          </p>
          {v?.headline?.changedBy ? (
            <p className="mt-1 text-xs text-[#a25b00]">
              Changed by rule “{v.headline.changedBy.replace(/_/g, " ")}”: {ACTION_LABELS[v.headline.final as ActionType] ?? v.headline.final.replace(/_/g, " ").toLowerCase()} instead.
            </p>
          ) : null}
          {blocked.map((b) => {
            const r = (b.result ?? {}) as { reason?: string; created?: string };
            return (
              <p key={b.id} className="mt-1 text-xs text-red-700" data-testid="hermes-blocked">
                {ACTION_LABELS[b.type as ActionType] ?? b.type} blocked by: {r.reason ?? "a rule"}
                {r.created ? <span className="text-gray-800"> · Action created: {r.created}</span> : null}
              </p>
            );
          })}
        </div>
      ) : v?.fallback ? (
        <p className="rounded-md bg-[#fff4e5] px-3 py-2 text-xs text-[#7a4b00]">
          Hermes could not read this ({v.fallback.hermesStatus.replace(/_/g, " ")}){v.fallback.error ? `: ${v.fallback.error}` : ""}. The rules&apos; extraction was used only where safe, and it waits for you.
        </p>
      ) : null}

      {!compact ? (
        <>
          {u.facts.length ? (
            <div>
              <p className="text-xs font-semibold text-gray-500">Facts (with evidence)</p>
              <ul className="mt-0.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {u.facts.map((f, i) => (
                  <li key={`${f.key}-${i}`} className="min-w-0 text-xs">
                    <span className="text-gray-500">{FACT_LABELS[f.key as FactKey] ?? f.key}:</span> {f.display} <span className="italic text-gray-400">“{f.evidence}”</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {blockingMissing.length ? <p className="text-xs text-red-700">Missing (blocks progress): {blockingMissing.map((m) => m.label).join(", ")}</p> : null}
          {u.commitments.length ? (
            <p className="text-xs text-gray-700">
              Commitments: {u.commitments.map((c) => `${c.owner === "get_secure" ? (c.ownerName ?? "Get Secure") : (c.ownerName ?? "Customer")} to ${c.action.toLowerCase()}${c.dueText ? ` (${c.dueText})` : ""}`).join("; ")}
            </p>
          ) : null}
          {u.objections.length ? <p className="text-xs text-gray-700">Objections: {u.objections.map((o) => `${o.kind} (“${o.evidence}”)`).join("; ")}</p> : null}
          {v ? (
            <div className="space-y-1">
              <CheckList title="Hard guardrails" items={v.hard ?? []} tone="text-red-700" />
              <CheckList title="Business rules" items={v.business ?? []} tone="text-[#a25b00]" />
              <CheckList title="Advisory (did not block)" items={v.advisories ?? []} tone="text-gray-500" />
            </div>
          ) : null}
          {brain ? (
            <p className="text-xs text-gray-700" data-testid="brain-status">
              Business Brain: {brain.status === "done" ? (brainResult?.complete ? "fully priced" : `ran, not fully priced${brainResult?.unpriced?.length ? ` (${brainResult.unpriced.length} unpriced)` : ""}`) : brain.status}
              {brainResult?.siteVisitRequired ? "; site visit required" : ""}
            </p>
          ) : null}
          <ul className="space-y-1">
            {actions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
                <ActionStatus status={a.status} />
                <span className="font-medium text-gray-900">{ACTION_LABELS[a.type as ActionType] ?? a.type}</span>
                <span className="text-gray-600">{a.reason}</span>
                {a.result && typeof (a.result as { quoteId?: unknown }).quoteId === "string" ? (
                  <Link href={`/quotes/${(a.result as { quoteId: string }).quoteId}`} className="text-brand-700 hover:underline">
                    open quote
                  </Link>
                ) : null}
                {a.result && typeof (a.result as { draftId?: unknown }).draftId === "string" ? (
                  <Link href="/approvals" className="text-brand-700 hover:underline">
                    draft in Approvals
                  </Link>
                ) : null}
                {a.result && typeof (a.result as { error?: unknown }).error === "string" ? <span className="text-red-600">({String((a.result as { error: string }).error)})</span> : null}
              </li>
            ))}
          </ul>
          {rules?.primaryIntent && inspection.engine !== "rules" ? (
            <p className="text-[11px] text-gray-400">
              Old rules (comparison only): {rules.primaryIntent.replace(/_/g, " ")}
              {rules.firstAction ? ` → ${rules.firstAction.replace(/_/g, " ").toLowerCase()}` : ""}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
