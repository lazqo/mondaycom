import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { listUsers } from "@/queries";
import { UsersAdmin } from "@/components/settings/users-admin";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const me = await requireAdmin();
  const users = await listUsers();
  return <UsersAdmin users={users} meId={me.id} />;
}
