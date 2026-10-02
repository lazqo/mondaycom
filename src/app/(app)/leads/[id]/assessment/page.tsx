import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads, recordingProfiles } from "@/db/schema";
import { requireOffice } from "@/lib/auth";
import { enquiryFromLead, latestAssessment } from "@/lib/brain/store";
import type { DecisionPacket, EnquiryInput } from "@/lib/brain/types";
import { AssessmentForm } from "@/components/brain/assessment-form";
import { PacketView } from "@/components/brain/packet-view";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "CCTV assessment" };

export default async function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOffice();
  const { id } = await params;
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id), columns: { id: true, name: true } });
  if (!lead) notFound();
  const [last, fromLead, profileRows] = await Promise.all([latestAssessment(id), enquiryFromLead(id), db.select().from(recordingProfiles)]);
  const profiles = profileRows
    .filter((p) => p.status !== "deprecated")
    .map((p) => ({ id: p.id, name: p.name, propertyType: p.propertyType, isDefault: p.isDefault, designed: p.rules.some((r) => r.designBitrateMbps != null) }));
  const initial = (last?.input as unknown as EnquiryInput) ?? fromLead!;

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/leads/${id}`} className="text-xs text-gray-500 hover:text-brand-700">
          ← {lead.name}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">CCTV assessment</h1>
        <p className="text-sm text-gray-500">
          The Business Brain works out the system, storage, network, materials and price from approved catalogue data and Get Secure rules. It prepares drafts for Chris; it never contacts the customer.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="xl:col-span-2">
          <AssessmentForm leadId={id} initial={initial} assessmentId={last?.id ?? null} canApprove={!!user.canApprove} profiles={profiles} />
        </div>
        <div className="xl:col-span-3">
          {last ? (
            <PacketView packet={last.packet as unknown as DecisionPacket} createdAt={formatDateTime(last.createdAt)} />
          ) : (
            <p className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">Check the enquiry details and press Run assessment.</p>
          )}
        </div>
      </div>
    </div>
  );
}
