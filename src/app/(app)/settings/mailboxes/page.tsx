import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { listMailboxes } from "@/queries/email";
import { MailboxesAdmin } from "@/components/settings/mailboxes-admin";

export const metadata: Metadata = { title: "Email accounts" };

export default async function MailboxesPage() {
  await requireAdmin();
  const boxes = await listMailboxes();
  return <MailboxesAdmin mailboxes={boxes.map((b) => ({ ...b, lastSyncAt: b.lastSyncAt?.toISOString() ?? null }))} />;
}
