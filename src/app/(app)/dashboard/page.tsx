import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDashboard } from "@/queries/dashboard";
import { listActiveUsers } from "@/queries";
import { runAutomationsIfDue } from "@/lib/automations/runner";
import { Badge, Card, CardHeader, LinkButton } from "@/components/ui";
import { TaskList } from "@/components/dashboard/task-list";
import { NewTaskButton } from "@/components/dashboard/new-task-dialog";
import { StatusPill } from "@/components/leads/cells";
import { EMAIL_CLASSIFICATION_META, JOB_STATUS_META, LEAD_URGENCY_META } from "@/lib/constants";
import { formatDateOnly, formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Today" };

function Section({ title, count, href, children, tone = "default" }: { title: string; count: number; href?: string; children: React.ReactNode; tone?: "default" | "warn" | "alert" }) {
  return (
    <Card data-testid={`section-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {title}
            <Badge className={count === 0 ? "bg-gray-100 text-gray-500" : tone === "alert" ? "bg-[#e2445c] text-white" : tone === "warn" ? "bg-[#ffcb00] text-gray-900" : "bg-brand-100 text-brand-800"}>{count}</Badge>
          </span>
        }
        action={href ? <Link href={href} className="text-sm text-brand-700 hover:underline">View all</Link> : null}
      />
      {count === 0 ? <p className="px-4 py-3 text-sm text-gray-500">Nothing here.</p> : <div className="divide-y divide-gray-100">{children}</div>}
    </Card>
  );
}

const row = "flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-gray-50";

export default async function DashboardPage() {
  const user = await requireUser();
  await runAutomationsIfDue(5);
  const [d, users] = await Promise.all([getDashboard(user.id), listActiveUsers()]);
  const attention = d.overdueTasks.length + d.needsReview.length + d.newLeads.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Today</h1>
          <p className="text-sm text-gray-500">
            {new Date().toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })} · {attention} {attention === 1 ? "item needs" : "items need"} attention · {d.activeJobCount} active jobs
          </p>
        </div>
        <div className="flex gap-2">
          <NewTaskButton users={users} />
          <LinkButton variant="secondary" href="/my-day">
            My day
          </LinkButton>
          <LinkButton variant="secondary" href="/calendar?view=day">
            Calendar
          </LinkButton>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4">
          <Section title="Overdue tasks" count={d.overdueTasks.length} tone="alert">
            <TaskList tasks={d.overdueTasks} />
          </Section>
          <Section title="Tasks due today" count={d.tasksToday.length} tone="warn">
            <TaskList tasks={d.tasksToday} />
          </Section>
          <Section title="Needs review" count={d.needsReview.length} href="/inbox?filter=needs_review" tone="warn">
            {d.needsReview.map((e) => (
              <Link key={e.id} href={`/inbox/${e.threadId}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">{e.subject || "(no subject)"}</span>
                  <span className="block truncate text-xs text-gray-500">{e.fromName || e.fromAddress} · {formatDateTime(e.receivedAt)}</span>
                </span>
                <Badge className={`${EMAIL_CLASSIFICATION_META[e.classification].bg} ${EMAIL_CLASSIFICATION_META[e.classification].text}`}>{EMAIL_CLASSIFICATION_META[e.classification].label}</Badge>
              </Link>
            ))}
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Today's jobs & site visits" count={d.todayEvents.length} href="/calendar?view=day">
            {d.todayEvents.map((e) => {
              const href = e.job ? `/jobs/${e.job.id}` : e.lead ? `/leads/${e.lead.id}` : `/calendar?view=day`;
              const where = e.job?.siteAddress ?? e.lead?.site ?? e.location;
              return (
                <Link key={e.id} href={href} className={row}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-900">
                      {new Date(e.startsAt).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })} · {e.job ? `J-${e.job.number} ${e.job.title}` : e.lead ? `Site visit: ${e.lead.name}` : e.title}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {where ?? "no address"}{e.assignedTo ? ` · ${e.assignedTo.name}` : " · unassigned"}
                    </span>
                  </span>
                  {e.job ? <Badge className={`${JOB_STATUS_META[e.job.status].bg} ${JOB_STATUS_META[e.job.status].text}`}>{JOB_STATUS_META[e.job.status].label}</Badge> : <Badge className="bg-[#ff9900] text-white">Site visit</Badge>}
                </Link>
              );
            })}
          </Section>
          <Section title="Unassigned jobs" count={d.unassignedJobs.length} href="/calendar?view=week" tone="warn">
            {d.unassignedJobs.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className={row}>
                <span className="truncate">
                  <span className="font-medium text-gray-900">J-{j.number}</span> {j.title} · <span className="text-gray-500">{j.contact.name}</span>
                </span>
                <span className="text-xs text-gray-500">{formatDateTime(j.createdAt)}</span>
              </Link>
            ))}
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="New leads" count={d.newLeads.length} href="/leads" tone="warn">
            {d.newLeads.map((l) => (
              <Link key={l.id} href={`/leads/${l.id}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">
                    {l.name}
                    {l.company ? <span className="font-normal text-gray-500"> · {l.company}</span> : null}
                  </span>
                  <span className="block truncate text-xs text-gray-500">{l.service ?? "service not set"} · {formatDateTime(l.createdAt)}</span>
                </span>
                {l.urgency ? <Badge className={`${LEAD_URGENCY_META[l.urgency].bg} ${LEAD_URGENCY_META[l.urgency].text}`}>{LEAD_URGENCY_META[l.urgency].label}</Badge> : null}
              </Link>
            ))}
          </Section>
          <Section title="Leads needing follow-up" count={d.followUps.length} href="/leads">
            {d.followUps.map((l) => (
              <Link key={l.id} href={`/leads/${l.id}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">{l.name}</span>
                  <span className="block truncate text-xs text-gray-500">
                    Follow-up {formatDateOnly(l.followUpAt)}{l.followUpAt && l.followUpAt < d.today ? " (overdue)" : ""}{l.assignedTo ? ` · ${l.assignedTo.name}` : ""}
                  </span>
                </span>
                <StatusPill value={l.status} />
              </Link>
            ))}
          </Section>
          <Section title="Quotes waiting on action" count={d.quotesDraft.length + d.quotesSent.length} href="/quotes">
            {d.quotesDraft.map((q) => (
              <Link key={q.id} href={`/quotes/${q.id}`} className={row}>
                <span className="truncate">
                  <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title} · <span className="text-gray-500">{q.contact.name}</span>
                </span>
                <span className="flex items-center gap-2 text-xs"><span>{formatMoney(q.total)}</span><Badge className="bg-gray-400 text-white">Draft</Badge></span>
              </Link>
            ))}
            {d.quotesSent.map((q) => (
              <Link key={q.id} href={`/quotes/${q.id}`} className={row}>
                <span className="truncate">
                  <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title} · <span className="text-gray-500">{q.contact.name}</span>
                </span>
                <span className="flex items-center gap-2 text-xs"><span>sent {q.sentAt ? formatDateOnly(q.sentAt.toISOString().slice(0, 10)) : ""}</span><Badge className="bg-[#0086c0] text-white">Sent</Badge></span>
              </Link>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
