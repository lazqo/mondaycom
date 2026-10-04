import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { brainCandidates, researchFindings } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { getResearchRuntime } from "@/lib/hermes/research";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui";
import { AskResearch, CandidateDecision } from "@/components/brain/research-panel";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Research" };

type Source = { url: string; title: string | null; tier: number; tierLabel: string; publishedAt: string | null };
type Finding = { claim: string; confidence: number; knowledge: string; sources: Source[] };

const TONE: Record<string, string> = { proposed: "bg-[#ffcb00] text-gray-900", accepted: "bg-[#00c875] text-white", rejected: "bg-gray-200 text-gray-600" };

function Sources({ sources }: { sources: Source[] }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {sources.map((s, i) => (
        <li key={i} className="text-xs text-gray-600">
          <Badge className="mr-1 bg-gray-100 text-gray-700">{s.tierLabel}</Badge>
          {/^https?:/.test(s.url) ? (
            <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-brand-700 hover:underline">
              {s.title || s.url}
            </a>
          ) : (
            <span>{s.title || s.url}</span>
          )}
          {s.publishedAt ? <span className="text-gray-400"> · {s.publishedAt}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * What Hermes found out from outside the CRM, and the changes to approved Business Brain knowledge
 * it proposes. Nothing here changes the catalogue, prices, labour or rules: Chris does that in the
 * Business Brain itself.
 */
export default async function ResearchPage() {
  const user = await requireAdmin();
  const [candidates, findings] = await Promise.all([
    db.select().from(brainCandidates).orderBy(desc(brainCandidates.createdAt)).limit(60),
    db.select().from(researchFindings).orderBy(desc(researchFindings.createdAt)).limit(30),
  ]);
  const open = candidates.filter((c) => c.status === "proposed");
  const decided = candidates.filter((c) => c.status !== "proposed");
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm">
          <Link href="/settings/brain" className="text-brand-700 hover:underline">
            ← Business Brain
          </Link>
        </p>
        <h1 className="text-xl font-semibold text-gray-900">Research</h1>
        <p className="text-sm text-gray-600">
          What Hermes researched outside the CRM (manufacturer documentation first, then approved suppliers, standards, trusted technical sources, and the general web only as support), with every source and its date. Proposed changes to approved
          knowledge wait here for {user.canApprove ? "you" : "Chris"}. Accepting records the decision; the catalogue, prices, labour and rules change only when you change them in the Business Brain. Trade prices are never taken from research.
        </p>
      </div>

      <Card>
        <CardHeader title="Ask Hermes to research" />
        <AskResearch connected={!!getResearchRuntime()} />
      </Card>

      <Card data-testid="brain-candidates">
        <CardHeader title={`Candidate Business Brain updates (${open.length} waiting)`} />
        {open.length === 0 ? <EmptyState title="Nothing waiting" hint="When Hermes finds a new product, compatibility or technical fact that is not approved knowledge, it is proposed here." /> : null}
        <div className="divide-y divide-gray-100">
          {[...open, ...decided].map((c) => (
            <div key={c.id} className="space-y-1 px-4 py-3 text-sm" data-testid="brain-candidate">
              <p className="flex flex-wrap items-center gap-2">
                <Badge className={TONE[c.status] ?? "bg-gray-200 text-gray-700"}>{c.status}</Badge>
                <Badge className="bg-brand-100 text-brand-800">{c.kind.replace(/_/g, " ")}</Badge>
                <span className="font-medium text-gray-900">{c.title}</span>
                <span className="text-xs text-gray-500">
                  {c.confidence ? `${Math.round(Number(c.confidence) * 100)}% · ` : ""}
                  {c.proposedBy} · {formatDateTime(c.createdAt)}
                </span>
              </p>
              {c.detail ? <p className="text-gray-700">{c.detail}</p> : null}
              {Object.keys(c.payload ?? {}).length ? <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-700">{JSON.stringify(c.payload, null, 2)}</pre> : null}
              <Sources sources={(c.sources ?? []) as unknown as Source[]} />
              {c.status === "proposed" ? <CandidateDecision id={c.id} canApprove={!!user.canApprove} /> : c.decisionNote ? <p className="text-xs text-gray-500">Note: {c.decisionNote}</p> : null}
            </div>
          ))}
        </div>
      </Card>

      <Card data-testid="research-findings">
        <CardHeader title="Recent research" />
        {findings.length === 0 ? <EmptyState title="No research yet" /> : null}
        <div className="divide-y divide-gray-100">
          {findings.map((f) => (
            <details key={f.id} className="px-4 py-3 text-sm">
              <summary className="cursor-pointer">
                <span className="font-medium text-gray-900">{f.question}</span>{" "}
                <span className="text-xs text-gray-500">
                  · {f.kind} · {f.status === "ok" ? `${(f.findings as unknown as Finding[]).length} finding(s)` : f.status.replace(/_/g, " ")} · {f.requestedBy.startsWith("user:") ? "asked by a person" : "asked by Hermes"} · {formatDateTime(f.createdAt)}
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                {f.summary ? <p className="text-gray-700">{f.summary}</p> : null}
                {f.error ? <p className="text-xs text-red-600">{f.error}</p> : null}
                {(f.findings as unknown as Finding[]).map((x, i) => (
                  <div key={i}>
                    <p>
                      <Badge className={x.knowledge === "approved" ? "mr-1 bg-[#00c875] text-white" : "mr-1 bg-[#579bfc] text-white"}>{x.knowledge === "approved" ? "approved knowledge" : "new information"}</Badge>
                      {x.claim} <span className="text-xs text-gray-500">({Math.round(x.confidence * 100)}%)</span>
                    </p>
                    <Sources sources={x.sources} />
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
