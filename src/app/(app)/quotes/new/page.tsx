import type { Metadata } from "next";
import { requireOffice } from "@/lib/auth";
import Link from "next/link";
import { listContacts } from "@/queries";
import { QuoteEditor } from "@/components/quotes/quote-editor";

export const metadata: Metadata = { title: "New quote" };

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; leadId?: string }>;
}) {
  await requireOffice();
  const [{ contactId, leadId }, contacts] = await Promise.all([searchParams, listContacts()]);
  return (
    <div className="space-y-4">
      <div>
        <Link href="/quotes" className="text-xs text-gray-500 hover:text-brand-700">
          ← Quotes
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">New quote</h1>
      </div>
      <QuoteEditor mode="create" contacts={contacts} defaultContactId={contactId} leadId={leadId} />
    </div>
  );
}
