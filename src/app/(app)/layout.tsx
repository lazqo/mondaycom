import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { decisionsCount } from "@/queries/decisions";
import { listNotifications, unreadNotificationCount } from "@/queries/dashboard";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [decisions, notifications, unread] = await Promise.all([user.role === "field" ? 0 : decisionsCount(), listNotifications(user.id, 20), unreadNotificationCount(user.id)]);
  return (
    <AppShell user={user} decisions={decisions} notifications={notifications} unread={unread}>
      {children}
    </AppShell>
  );
}
