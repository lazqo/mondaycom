import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { needsReviewCount } from "@/queries/email";
import { listNotifications, unreadNotificationCount } from "@/queries/dashboard";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [needsReview, notifications, unread] = await Promise.all([needsReviewCount(), listNotifications(user.id, 20), unreadNotificationCount(user.id)]);
  return (
    <AppShell user={user} needsReview={needsReview} notifications={notifications} unread={unread}>
      {children}
    </AppShell>
  );
}
