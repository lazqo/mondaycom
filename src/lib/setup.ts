import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, users, appSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { getSetting, setSetting } from "@/lib/settings";

export const SETUP_KEY = "setup";
export type SetupState = { completedAt?: string; hoursConfirmedAt?: string; aiConfirmedAt?: string };

export async function hasAnyUser(): Promise<boolean> {
  const [{ n }] = await db.select({ n: count() }).from(users);
  return Number(n) > 0;
}

export async function getSetupState(): Promise<SetupState> {
  return (await getSetting<SetupState>(SETUP_KEY)) ?? {};
}

export async function patchSetupState(patch: Partial<SetupState>) {
  const cur = await getSetupState();
  await setSetting(SETUP_KEY, { ...cur, ...patch });
}

export type SetupStep = { key: string; title: string; done: boolean; detail: string; href: string; action?: string };

/** Derives each step's state from real data, so the checklist is never out of date. */
export async function getSetupSteps(): Promise<{ steps: SetupStep[]; complete: boolean }> {
  const [[{ staff }], boxes, state, settingsRow] = await Promise.all([
    db.select({ staff: count() }).from(users),
    db.query.mailboxes.findMany({ where: eq(mailboxes.active, true), columns: { id: true, emailAddress: true, lastSyncAt: true, lastError: true } }),
    getSetupState(),
    db.query.appSettings.findFirst({ where: eq(appSettings.key, "automations") }),
  ]);
  const aiLive = env.AI_PROVIDER === "anthropic" || (env.AI_PROVIDER === "auto" && !!env.ANTHROPIC_API_KEY);
  const steps: SetupStep[] = [
    { key: "admin", title: "Admin login", done: Number(staff) >= 1, detail: "Your admin account exists.", href: "/settings/users" },
    {
      key: "staff",
      title: "Add staff",
      done: Number(staff) >= 2,
      detail: Number(staff) >= 2 ? `${staff} people can sign in.` : "Add office staff and technicians so jobs can be assigned.",
      href: "/settings/users",
      action: "Add staff",
    },
    {
      key: "titan",
      title: "Connect Titan email",
      done: boxes.length > 0 && boxes.some((b) => b.lastSyncAt && !b.lastError),
      detail: boxes.length === 0 ? "Connect the mailbox that receives enquiries." : boxes[0].lastError ? `Connected but the last check failed: ${boxes[0].lastError}` : boxes[0].lastSyncAt ? `${boxes[0].emailAddress} is syncing.` : `${boxes[0].emailAddress} connected; run “Check for new email” once.`,
      href: "/settings/mailboxes",
      action: "Connect mailbox",
    },
    {
      key: "ai",
      title: "Configure email AI",
      done: aiLive ? true : !!state.aiConfirmedAt,
      detail: aiLive ? `Claude (${env.AI_MODEL}) is reading enquiries.` : "No API key set: the offline rules classifier is in use. Add ANTHROPIC_API_KEY on the server, or confirm you want to start with rules.",
      href: "/settings/ai",
      action: aiLive ? undefined : "Use offline rules for now",
    },
    {
      key: "hours",
      title: "Business hours & reminder rules",
      done: !!settingsRow || !!state.hoursConfirmedAt,
      detail: settingsRow ? "Saved." : "Set your working hours for the calendar and when reminders should fire.",
      href: "/settings/automations",
      action: "Review settings",
    },
  ];
  const complete = !!state.completedAt;
  return { steps, complete };
}
