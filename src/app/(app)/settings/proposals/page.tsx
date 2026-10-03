import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { Card, CardHeader } from "@/components/ui";
import { ProposalSettingsForm } from "@/components/settings/proposal-settings-form";
import { getProposalSettings } from "@/lib/proposals/settings";

export const metadata: Metadata = { title: "Proposals" };

export default async function ProposalSettingsPage() {
  await requireAdmin();
  const settings = await getProposalSettings();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Customer proposals</h1>
        <p className="text-sm text-gray-500">
          The company details and standard wording printed on every branded PDF proposal. Product names, descriptions, highlights and photos are set per product under Business Brain → Products.
        </p>
      </div>
      <Card>
        <CardHeader title="Printed on every proposal" />
        <div className="p-4">
          <ProposalSettingsForm settings={settings} />
        </div>
      </Card>
    </div>
  );
}
