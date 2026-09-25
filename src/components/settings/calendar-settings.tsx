"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { deleteCalendarConnection, findCalendars, saveCalendarConnection, syncCalendarNow } from "@/actions/calendar-sync";
import { Badge, Button, Card, CardHeader, Field, FormError, Input, Select } from "@/components/ui";
import { EVENT_KIND_LABELS, type EventKind } from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";

export type CalendarConnectionView = {
  id: string;
  name: string;
  serverUrl: string;
  username: string;
  calendarUrl: string;
  calendarName: string | null;
  pushKinds: string[];
  active: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  paired: number;
};

const TITAN_SERVER = "https://dav.flockmail.com";
const KINDS: EventKind[] = ["site_visit", "job", "other"];

export function CalendarSettings({ connection, syncSeconds, inProcess }: { connection: CalendarConnectionView | null; syncSeconds: number; inProcess: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(!connection);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const [serverUrl, setServerUrl] = React.useState(connection?.serverUrl ?? TITAN_SERVER);
  const [username, setUsername] = React.useState(connection?.username ?? "");
  const [password, setPassword] = React.useState("");
  const [calendars, setCalendars] = React.useState<{ url: string; name: string }[]>(
    connection ? [{ url: connection.calendarUrl, name: connection.calendarName ?? connection.calendarUrl }] : [],
  );
  const [calendarUrl, setCalendarUrl] = React.useState(connection?.calendarUrl ?? "");
  const [kinds, setKinds] = React.useState<string[]>(connection?.pushKinds ?? KINDS);
  const [active, setActive] = React.useState(connection?.active ?? true);

  function find() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await findCalendars({ id: connection?.id ?? null, serverUrl, username, password: password || undefined });
      if (!res.ok) return setError(res.error);
      setCalendars(res.data);
      setCalendarUrl((cur) => (res.data.some((c) => c.url === cur) ? cur : res.data[0].url));
      setMessage(`Signed in. Found ${res.data.length} calendar${res.data.length === 1 ? "" : "s"}.`);
    });
  }

  function save() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await saveCalendarConnection({
        id: connection?.id ?? null,
        name: "Titan calendar",
        serverUrl,
        username,
        password: password || undefined,
        calendarUrl,
        calendarName: calendars.find((c) => c.url === calendarUrl)?.name,
        pushKinds: kinds,
        active,
      });
      if (!res.ok) return setError(res.error);
      setPassword("");
      setEditing(false);
      // Copy existing events across straight away rather than waiting for the next pass.
      const sync = await syncCalendarNow();
      setMessage(sync.ok ? `Connected. ${describe(sync.data)}` : `Connected, but the first sync failed: ${sync.error}`);
      router.refresh();
    });
  }

  function sync() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await syncCalendarNow();
      if (!res.ok) setError(res.error);
      else setMessage(describe(res.data));
      router.refresh();
    });
  }

  function disconnect() {
    if (!connection) return;
    if (!confirm("Disconnect the calendar? Events already in either calendar stay where they are; they just stop syncing.")) return;
    startTransition(async () => {
      const res = await deleteCalendarConnection(connection.id);
      if (!res.ok) return setError(res.error);
      setEditing(true);
      setCalendars([]);
      setCalendarUrl("");
      router.refresh();
    });
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Calendar sync</h1>
        <p className="text-sm text-gray-600">
          Keep the CRM calendar and your Titan calendar in step. Site visits, jobs and appointments made in the CRM appear in Titan, and on any phone or
          computer that shows your Titan calendar. Events added or changed in Titan appear here.
        </p>
      </div>

      {connection && !editing ? (
        <Card data-testid="calendar-connection">
          <CardHeader
            title={connection.calendarName ?? "Calendar"}
            action={
              <Badge className={connection.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}>{connection.active ? "Syncing" : "Paused"}</Badge>
            }
          />
          <div className="space-y-1 p-4 text-sm text-gray-700">
            <p>
              {connection.username} on {connection.serverUrl}
            </p>
            <p>Copies to the calendar: {connection.pushKinds.map((k) => EVENT_KIND_LABELS[k as EventKind] ?? k).join(", ") || "nothing"}</p>
            <p>
              Last sync: {connection.lastSyncAt ? formatDateTime(connection.lastSyncAt) : "never"} · {connection.paired} event{connection.paired === 1 ? "" : "s"} paired
            </p>
            <p className="text-xs text-gray-500">
              {inProcess ? `Checks for changes every ${Math.round(syncSeconds / 60)} minutes, and sends CRM changes straight away.` : "Background sync is off on this server; use Sync now."}
            </p>
            {connection.lastError ? <p className="text-xs text-red-600">Last error: {connection.lastError}</p> : null}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button size="sm" onClick={sync} disabled={pending} data-testid="calendar-sync-now">
                <RefreshCw className={pending ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> {pending ? "Syncing…" : "Sync now"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={pending}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={disconnect} disabled={pending}>
                Disconnect
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader title={connection ? "Edit calendar connection" : "Connect a calendar"} />
          <div className="space-y-3 p-4">
            <Field label="Calendar server" htmlFor="cal-server" hint="Titan: https://dav.flockmail.com (EU accounts: https://dav-eu.titan.email)">
              <Input id="cal-server" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </Field>
            <Field label="Username" htmlFor="cal-user" hint="Your full Titan email address">
              <Input id="cal-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="you@getsecure.co.nz" autoComplete="off" />
            </Field>
            <Field label="Password / app password" htmlFor="cal-pass" hint={connection ? "Leave blank to keep the saved password" : "Stored encrypted, like the mailbox password"}>
              <Input id="cal-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
            <Button type="button" variant="secondary" onClick={find} disabled={pending || !serverUrl || !username}>
              Find calendars
            </Button>

            {calendars.length ? (
              <>
                <Field label="Calendar" htmlFor="cal-choice">
                  <Select id="cal-choice" value={calendarUrl} onChange={(e) => setCalendarUrl(e.target.value)}>
                    {calendars.map((c) => (
                      <option key={c.url} value={c.url}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <fieldset className="space-y-1 text-sm">
                  <legend className="mb-1 font-medium text-gray-700">Copy these CRM events to the calendar</legend>
                  {KINDS.map((k) => (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={kinds.includes(k)}
                        onChange={(e) => setKinds((cur) => (e.target.checked ? [...cur, k] : cur.filter((x) => x !== k)))}
                        aria-label={`Copy ${EVENT_KIND_LABELS[k]}s`}
                      />
                      {EVENT_KIND_LABELS[k]}s
                    </label>
                  ))}
                </fieldset>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Sync is on
                </label>
              </>
            ) : null}

            <div className="flex justify-end gap-2">
              {connection ? (
                <Button type="button" variant="secondary" onClick={() => setEditing(false)} disabled={pending}>
                  Cancel
                </Button>
              ) : null}
              <Button type="button" onClick={save} disabled={pending || !calendarUrl}>
                {connection ? "Save" : "Connect calendar"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {message ? (
        <p className="text-sm text-gray-700" data-testid="calendar-message">
          {message}
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

function describe(r: { created: number; updated: number; deleted: number; pushed: number; errors: string[] }): string {
  const parts = [
    `${r.pushed} change${r.pushed === 1 ? "" : "s"} sent to the calendar`,
    `${r.created} new from the calendar`,
    `${r.updated} updated`,
    `${r.deleted} removed`,
  ];
  return `Synced: ${parts.join(", ")}.${r.errors.length ? ` Problems: ${r.errors.join("; ")}` : ""}`;
}
