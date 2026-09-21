"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle } from "lucide-react";
import { completeSetup, confirmSetupStep, reopenSetup } from "@/actions/setup";
import { Button, Card, LinkButton } from "@/components/ui";
import type { SetupStep } from "@/lib/setup";
import { cn } from "@/lib/utils";

export function SetupChecklist({ steps, complete }: { steps: SetupStep[]; complete: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  return (
    <div className="space-y-3">
      <Card>
        <ol className="divide-y divide-gray-100">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-start gap-3 px-4 py-3" data-testid={`setup-step-${s.key}`}>
              {s.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-gray-300" />}
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", s.done ? "text-gray-700" : "text-gray-900")}>
                  {i + 1}. {s.title}
                </p>
                <p className="text-xs text-gray-500">{s.detail}</p>
              </div>
              {!s.done ? (
                s.key === "ai" && s.action ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await confirmSetupStep("ai");
                        router.refresh();
                      })
                    }
                  >
                    {s.action}
                  </Button>
                ) : s.key === "hours" ? (
                  <LinkButton size="sm" variant="secondary" href={s.href}>
                    {s.action}
                  </LinkButton>
                ) : (
                  <LinkButton size="sm" variant="secondary" href={s.href}>
                    {s.action ?? "Open"}
                  </LinkButton>
                )
              ) : (
                <Link href={s.href} className="text-xs text-gray-500 hover:text-brand-700">
                  Change
                </Link>
              )}
            </li>
          ))}
          <li className="flex items-start gap-3 px-4 py-3" data-testid="setup-step-done">
            {complete ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-gray-300" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900">6. Start using the CRM</p>
              <p className="text-xs text-gray-500">
                {complete ? "Setup is complete. Today is your home screen." : allDone ? "Everything is ready." : `${doneCount} of ${steps.length} steps done. You can start now and finish the rest later.`}
              </p>
            </div>
            {complete ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await reopenSetup();
                    router.refresh();
                  })
                }
              >
                Show again
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await completeSetup();
                    router.push("/dashboard");
                    router.refresh();
                  })
                }
              >
                Go to Today
              </Button>
            )}
          </li>
        </ol>
      </Card>
      <p className="text-xs text-gray-500">
        Server settings (API keys, database, timezone) live in the hosting environment, not here. See <code>docs/PRODUCTION_ENV.md</code>.
      </p>
    </div>
  );
}
