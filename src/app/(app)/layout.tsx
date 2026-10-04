import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { needsReviewCount } from "@/queries/email";
import { inspectorReviewCount } from "@/queries/inspector";
import { listNotifications, unreadNotificationCount } from "@/queries/dashboard";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [needsReview, inspectorReview, notifications, unread] = await Promise.all([needsReviewCount(), user.role === "field" ? 0 : inspectorReviewCount(), listNotifications(user.id, 20), unreadNotificationCount(user.id)]);
  return (
    <AppShell user={user} needsReview={needsReview} inspectorReview={inspectorReview} notifications={notifications} unread={unread}>
      {children}
    </AppShell>
  );
}
