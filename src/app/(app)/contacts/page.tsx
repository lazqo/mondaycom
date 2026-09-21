import type { Metadata } from "next";
import Link from "next/link";
import { listContacts } from "@/queries";
import { EmptyState } from "@/components/ui";
import { NewContactButton } from "@/components/contacts/contact-form";

export const metadata: Metadata = { title: "Customers" };

export default async function ContactsPage() {
  const contacts = await listContacts();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Customers</h1>
          <p className="text-sm text-gray-500">{contacts.length} customers</p>
        </div>
        <NewContactButton />
      </div>
      {contacts.length === 0 ? (
        <EmptyState title="No customers yet" hint="A customer is created when you convert a lead. You can also add one directly." action={<NewContactButton />} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <Link href={`/contacts/${c.id}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{c.company ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-700">{c.email ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-700">{c.phone ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-700">{c.address ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
