import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { appDay, getDashboard } from "@/queries/dashboard";
import { getOutstandingCommitments } from "@/queries/inspector";
import { getDecisions, getHermesFeed } from "@/queries/decisions";
import { CommitmentLine } from "@/components/inspector/views";
import { DecisionsQueue } from "@/components/decisions/queue";
import { HermesFeed } from "@/components/decisions/feed";
import { listActiveUsers } from "@/queries";
import { runAutomationsIfDue } from "@/lib/automations/runner";
import { getSetupSteps } from "@/lib/setup";
import { Badge, Card, CardHeader, LinkButton } from "@/components/ui";
import { TaskList } from "@/components/dashboard/task-list";
import { NewTaskButton } from "@/components/dashboard/new-task-dialog";
import { StatusPill } from "@/components/leads/cells";
import { JOB_STATUS_META, LEAD_URGENCY_META } from "@/lib/constants";
import { formatDate, formatDateOnly, formatDateTime, formatMoney, formatTime } from "@/lib/utils";
import { db } from "@/db";
import { contacts, jobs, leads } from "@/db/schema";
import { inArray } from "drizzle-orm";

export const metadata: Metadata = { title: "Home" };

const MAX_ROWS = 8;

function Section({ title, count, href, children, tone = "default", empty = "Nothing here." }: { title: string; count: number; href?: string; children: React.ReactNode; tone?: "default" | "warn" | "alert"; empty?: string }) {
  const hidden = count - MAX_ROWS;
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
      {count === 0 ? (
        <p className="px-4 py-3 text-sm text-gray-500">{empty}</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {children}
          {hidden > 0 && href ? (
            <Link href={href} className="block px-4 py-2 text-center text-xs text-brand-700 hover:bg-gray-50 hover:underline">
              {hidden} more · view all
            </Link>
          ) : null}
        </div>
      )}
    </Card>
  );
}

const row = "flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-gray-50";

/**
 * Home: the brief, the Decisions queue (everything that waits on Chris, whatever produced it),
 * today's schedule and open loops, and the feed of what Hermes did.
 */
export default async function HomePage() {
  const user = await requireUser();
  if (user.role === "field") redirect("/my-day");
  await runAutomationsIfDue(5);
  const [d, users, setup, commitmentItems, decisions, feed] = await Promise.all([
    getDashboard(user.id),
    listActiveUsers(),
    user.role === "admin" ? getSetupSteps() : Promise.resolve(null),
    getOutstandingCommitments(),
    getDecisions(),
    getHermesFeed(20),
  ]);
  const now = new Date();
  const endOfToday = appDay(now).end;
  const ours = commitmentItems.filter((c) => c.commitment.owner !== "customer" && (!c.commitment.dueAt || c.commitment.dueAt <= endOfToday || c.commitment.dueAt < now));
  const oursOverdue = ours.filter((c) => c.commitment.dueAt && c.commitment.dueAt < now).length;
  const theirs = commitmentItems.filter((c) => c.commitment.owner === "customer");
  const hermesOff = !process.env.HERMES_API_URL || !process.env.HERMES_API_KEY;
  // Names for the feed's subjects.
  const leadIds = [...new Set(feed.map((f) => f.leadId).filter((x): x is string => !!x))];
  const contactIds = [...new Set(feed.map((f) => f.contactId).filter((x): x is string => !!x))];
  const jobIds = [...new Set(feed.map((f) => f.jobId).filter((x): x is string => !!x))];
  const [ls, cs, js] = await Promise.all([
    leadIds.length ? db.select({ id: leads.id, name: leads.name }).from(leads).where(inArray(leads.id, leadIds)) : [],
    contactIds.length ? db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, contactIds)) : [],
    jobIds.length ? db.select({ id: jobs.id, number: jobs.number, title: jobs.title }).from(jobs).where(inArray(jobs.id, jobIds)) : [],
  ]);
  const subjects = new Map<string, { label: string; href: string }>([
    ...js.map((j): [string, { label: string; href: string }] => [j.id, { label: `J-${j.number} ${j.title}`, href: `/jobs/${j.id}` }]),
    ...ls.map((l): [string, { label: string; href: string }] => [l.id, { label: l.name, href: `/leads/${l.id}` }]),
    ...cs.map((c): [string, { label: string; href: string }] => [c.id, { label: c.name, href: `/contacts/${c.id}` }]),
  ]);
  const hour = Number(new Intl.DateTimeFormat("en-NZ", { hour: "numeric", hour12: false, timeZone: process.env.APP_TIMEZONE ?? "Pacific/Auckland" }).format(new Date()));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(" ")[0];
  const brief = [
    decisions.total ? `${decisions.total} decision${decisions.total === 1 ? "" : "s"} waiting` : "nothing waiting on you",
    `${d.todayEvents.length} on the calendar today`,
    d.overdueTasks.length ? `${d.overdueTasks.length} overdue reminder${d.overdueTasks.length === 1 ? "" : "s"}` : null,
    oursOverdue ? `${oursOverdue} promise${oursOverdue === 1 ? "" : "s"} overdue` : null,
    `${d.activeJobCount} active jobs`,
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      {setup && !setup.complete ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-900" data-testid="setup-banner">
          <span>
            Setup: {setup.steps.filter((s) => s.done).length} of {setup.steps.length} steps done.
          </span>
          <Link href="/setup" className="font-medium underline">
            Finish setting up →
          </Link>
        </div>
      ) : null}
      {hermesOff ? (
        <div className="rounded-md border border-[#ffcb00] bg-[#fff8db] px-4 py-2.5 text-sm text-gray-900" data-testid="hermes-offline">
          <span className="font-medium">Hermes is not connected.</span> Every new email and conversation waits for you below until it is.{" "}
          <Link href="/settings/hermes" className="text-brand-700 underline">
            Settings → Hermes
          </Link>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            {greeting}, {firstName}
          </h1>
          <p className="text-sm text-gray-500" data-testid="brief">
            {new Date().toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", timeZone: process.env.APP_TIMEZONE ?? "Pacific/Auckland" })} · {brief.join(" · ")}
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

      <DecisionsQueue d={decisions} canApprove={!!user.canApprove} showEmpty={false} />
      {decisions.total === 0 ? (
        <Card data-testid="decisions-empty">
          <p className="px-4 py-3 text-sm text-gray-500">Nothing waits on you. What Hermes did on its own is below; anything it needs you for will appear here.</p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4">
          <Section title="Today's jobs & site visits" count={d.todayEvents.length} href="/calendar?view=day" empty="Nothing on the calendar today.">
            {d.todayEvents.slice(0, MAX_ROWS).map((e) => {
              const href = e.job ? `/jobs/${e.job.id}` : e.lead ? `/leads/${e.lead.id}` : `/calendar?view=day`;
              const where = e.job?.siteAddress ?? e.lead?.site ?? e.location;
              return (
                <Link key={e.id} href={href} className={row}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-900">
                      {formatTime(e.startsAt)} · {e.job ? `J-${e.job.number} ${e.job.title}` : e.lead ? `Site visit: ${e.lead.name}` : e.title}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {where ?? "no address"}
                      {e.assignedTo ? ` · ${e.assignedTo.name}` : " · unassigned"}
                    </span>
                  </span>
                  {e.job ? <Badge className={`${JOB_STATUS_META[e.job.status].bg} ${JOB_STATUS_META[e.job.status].text}`}>{JOB_STATUS_META[e.job.status].label}</Badge> : <Badge className="bg-[#ff9900] text-white">Site visit</Badge>}
                </Link>
              );
            })}
          </Section>
          <Section title="Our commitments" count={ours.length} tone={oursOverdue ? "alert" : "warn"} empty="Nothing promised for today. When Chris says “I'll send the quote tonight” on a call, it shows up here.">
            {ours.slice(0, MAX_ROWS).map((c) => (
              <CommitmentLine key={c.commitment.id} item={c} now={now} />
            ))}
          </Section>
          <Section title="Waiting on customers" count={theirs.length} empty="No customer has said they'll send anything.">
            {theirs.slice(0, MAX_ROWS).map((c) => (
              <CommitmentLine key={c.commitment.id} item={c} now={now} />
            ))}
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Overdue reminders" count={d.overdueTasks.length} tone="alert" empty="Nothing overdue. Nice.">
            <TaskList tasks={d.overdueTasks} />
          </Section>
          <Section title="Reminders for today" count={d.tasksToday.length} tone="warn" empty="No reminders due today.">
            <TaskList tasks={d.tasksToday} />
          </Section>
          <Section title="Jobs not yet scheduled" count={d.unassignedJobs.length} href="/calendar?view=week" tone="warn" empty="Every job has a time on the calendar.">
            {d.unassignedJobs.slice(0, MAX_ROWS).map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className={row}>
                <span className="truncate">
                  <span className="font-medium text-gray-900">J-{j.number}</span> {j.title} · <span className="text-gray-500">{j.contact.name}</span>
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs text-gray-500">{formatDate(j.createdAt)}</span>
              </Link>
            ))}
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="New leads" count={d.newLeads.length} href="/leads" tone="warn" empty="No new enquiries waiting. They arrive here from email or when someone adds one.">
            {d.newLeads.slice(0, MAX_ROWS).map((l) => (
              <Link key={l.id} href={`/leads/${l.id}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">
                    {l.name}
                    {l.company ? <span className="font-normal text-gray-500"> · {l.company}</span> : null}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {l.service ?? "service not set"} · {formatDateTime(l.createdAt)}
                  </span>
                </span>
                {l.urgency ? <Badge className={`${LEAD_URGENCY_META[l.urgency].bg} ${LEAD_URGENCY_META[l.urgency].text}`}>{LEAD_URGENCY_META[l.urgency].label}</Badge> : null}
              </Link>
            ))}
          </Section>
          <Section title="Leads needing follow-up" count={d.followUps.length} href="/leads" empty="No follow-ups due. Set a Follow-up date on a lead and it will show up here on the day.">
            {d.followUps.slice(0, MAX_ROWS).map((l) => (
              <Link key={l.id} href={`/leads/${l.id}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">{l.name}</span>
                  <span className="block truncate text-xs text-gray-500">
                    Follow-up {formatDateOnly(l.followUpAt)}
                    {l.followUpAt && l.followUpAt < d.today ? " (overdue)" : ""}
                    {l.assignedTo ? ` · ${l.assignedTo.name}` : ""}
                  </span>
                </span>
                <StatusPill value={l.status} />
              </Link>
            ))}
          </Section>
          <Section title="Quotes waiting on action" count={d.quotesDraft.length + d.quotesSent.length} href="/quotes" empty="No draft or unanswered quotes.">
            {d.quotesDraft.slice(0, MAX_ROWS).map((q) => (
              <Link key={q.id} href={`/quotes/${q.id}`} className={row}>
                <span className="truncate">
                  <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title} · <span className="text-gray-500">{q.contact?.name ?? "Lead, not yet a customer"}</span>
                </span>
                <span className="flex items-center gap-2 text-xs">
                  <span>{formatMoney(q.total)}</span>
                  <Badge className="bg-gray-400 text-white">Draft</Badge>
                </span>
              </Link>
            ))}
            {d.quotesSent.slice(0, Math.max(0, MAX_ROWS - d.quotesDraft.length)).map((q) => (
              <Link key={q.id} href={`/quotes/${q.id}`} className={row}>
                <span className="truncate">
                  <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title} · <span className="text-gray-500">{q.contact?.name ?? "Lead, not yet a customer"}</span>
                </span>
                <span className="flex items-center gap-2 text-xs">
                  <span className="whitespace-nowrap">sent {formatDate(q.sentAt)}</span>
                  <Badge className="bg-[#0086c0] text-white">Sent</Badge>
                </span>
              </Link>
            ))}
          </Section>
        </div>
      </div>

      <HermesFeed items={feed} subjects={subjects} />
    </div>
  );
}
