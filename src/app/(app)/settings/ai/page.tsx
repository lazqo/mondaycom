import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/db";
import { emailClassifications } from "@/db/schema";
import { env } from "@/lib/env";
import { Badge, Card, CardHeader } from "@/components/ui";
import { AiSmokeTest } from "@/components/settings/ai-smoke-test";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Email AI" };

export default async function AiSettingsPage() {
  await requireAdmin();
  const active = env.AI_PROVIDER === "anthropic" || (env.AI_PROVIDER === "auto" && !!env.ANTHROPIC_API_KEY) ? "anthropic" : "rules";
  const recent = await db.query.emailClassifications.findMany({
    orderBy: [desc(emailClassifications.createdAt)],
    limit: 40,
    with: { email: { columns: { id: true, threadId: true, subject: true, fromAddress: true, classification: true, leadId: true } }, reviewedBy: { columns: { name: true } } },
  });
  const reviewed = recent.filter((r) => r.reviewOutcome);
  const accepted = reviewed.filter((r) => r.reviewOutcome !== "rejected").length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Email AI</h1>
        <p className="text-sm text-gray-500">How incoming enquiries are read and turned into leads. Every decision is recorded so you can check it.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Status" />
          <dl className="grid grid-cols-[130px_1fr] gap-y-2 p-4 text-sm">
            <dt className="text-gray-500">Active provider</dt>
            <dd>
              <Badge className={active === "anthropic" ? "bg-[#00c875] text-white" : "bg-gray-400 text-white"}>{active === "anthropic" ? "Anthropic (Claude)" : "Offline rules"}</Badge>
            </dd>
            <dt className="text-gray-500">AI_PROVIDER</dt>
            <dd>{env.AI_PROVIDER}</dd>
            <dt className="text-gray-500">Model</dt>
            <dd>{active === "anthropic" ? env.AI_MODEL : "—"}</dd>
            <dt className="text-gray-500">API key</dt>
            <dd>{env.ANTHROPIC_API_KEY ? "configured" : "not set"}</dd>
            <dt className="text-gray-500">Auto-create at</dt>
            <dd>≥ {Math.round(env.AI_LEAD_CONFIDENCE_THRESHOLD * 100)}% confidence</dd>
            <dt className="text-gray-500">Reviewed</dt>
            <dd>
              {reviewed.length} decisions · {reviewed.length ? `${Math.round((accepted / reviewed.length) * 100)}% accepted` : "—"}
            </dd>
          </dl>
          <div className="border-t border-gray-200 p-4">
            <AiSmokeTest />
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Recent classifications" />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs font-medium text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Email</th>
                  <th className="px-3 py-2 text-left">Result</th>
                  <th className="px-3 py-2 text-left">Extracted</th>
                  <th className="px-3 py-2 text-left">Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-3 text-gray-500">No classifications yet.</td>
                  </tr>
                ) : null}
                {recent.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-gray-50">
                    <td className="max-w-[220px] px-3 py-2">
                      <Link href={`/inbox/${r.email.threadId}`} className="block truncate font-medium text-gray-900 hover:underline">
                        {r.email.subject || "(no subject)"}
                      </Link>
                      <p className="truncate text-xs text-gray-500">{r.email.fromAddress} · {formatDateTime(r.createdAt)}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Badge className={r.isLead ? "bg-[#00c875] text-white" : "bg-gray-400 text-white"}>{r.isLead ? "Lead" : "Not lead"}</Badge>
                      <p className="text-xs text-gray-500">
                        {Math.round(Number(r.confidence) * 100)}% · {r.provider}
                        {r.model ? ` · ${r.model}` : ""}
                      </p>
                    </td>
                    <td className="max-w-[320px] px-3 py-2 text-xs text-gray-700">
                      {[r.result.contact_name, r.result.company, r.result.phone, r.result.service, r.result.site_address].filter(Boolean).join(" · ") || "—"}
                      <p className="truncate text-gray-500">{r.result.summary}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600">
                      {r.reviewOutcome ? `${r.reviewOutcome}${r.reviewedBy ? ` by ${r.reviewedBy.name}` : ""}` : r.email.classification === "lead" && !r.reviewOutcome ? "auto" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
