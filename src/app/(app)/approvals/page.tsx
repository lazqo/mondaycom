import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/lib/auth";
import { getDecisions } from "@/queries/decisions";
import { DecisionsQueue } from "@/components/decisions/queue";

export const metadata: Metadata = { title: "Approvals" };

/** The customer-facing part of the Decisions queue (quotes and replies), on its own page. Home shows the same cards. */
export default async function ApprovalsPage() {
  const user = await requireOffice();
  const d = await getDecisions();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Approvals</h1>
        <p className="text-sm text-gray-500">
          Everything prepared for a customer waits here. Nothing reaches a customer until {user.canApprove ? "you approve and send it" : "Chris approves it"}. The same cards are on{" "}
          <Link href="/dashboard" className="text-brand-700 hover:underline">
            Home
          </Link>
          .
        </p>
      </div>
      <DecisionsQueue d={d} canApprove={!!user.canApprove} kinds={["quote", "reply"]} />
    </div>
  );
}
