import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { needsReviewCount } from "@/queries/email";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, needsReview] = await Promise.all([requireUser(), needsReviewCount()]);
  return (
    <AppShell user={user} needsReview={needsReview}>
      {children}
    </AppShell>
  );
}
