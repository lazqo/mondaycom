/**
 * A CalDAV connection (Titan: https://dav.flockmail.com, username = the mailbox address).
 * Thin wrapper over tsdav that finds the account from whatever URL the user gave.
 */
import { createDAVClient, type DAVCalendar } from "tsdav";

export type CalDavCredentials = { serverUrl: string; username: string; password: string };
export type DavClient = Awaited<ReturnType<typeof createDAVClient>>;
export type CalendarChoice = { url: string; name: string };

/** URLs worth trying, in order: what the user typed, then the usual principal locations. */
function candidates(serverUrl: string): string[] {
  const out = [serverUrl];
  try {
    const u = new URL(serverUrl);
    out.push(`${u.origin}/principals/`, `${u.origin}/`);
  } catch {
    // Not a URL; the first attempt reports that.
  }
  return [...new Set(out)];
}

export async function connectCalDav(c: CalDavCredentials): Promise<DavClient> {
  let lastError: unknown = null;
  for (const serverUrl of candidates(c.serverUrl)) {
    try {
      return await createDAVClient({
        serverUrl,
        credentials: { username: c.username, password: c.password },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
    } catch (err) {
      lastError = err;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(/401|unauthori[sz]ed/i.test(msg) ? "The calendar server rejected the username or password" : `Could not reach the calendar server: ${msg}`);
}

/** Calendars that can hold events (task lists and address books are left out). */
export async function listEventCalendars(client: DavClient): Promise<CalendarChoice[]> {
  const cals = await client.fetchCalendars();
  return cals
    .filter((c) => !c.components?.length || c.components.includes("VEVENT"))
    .map((c) => ({ url: c.url, name: typeof c.displayName === "string" && c.displayName ? c.displayName : c.url }));
}

export function calendarRef(url: string): DAVCalendar {
  return { url } as DAVCalendar;
}

/** Same calendar whether or not the URL has "%40" for "@" or a trailing slash. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => decodeURIComponent(u).replace(/\/+$/, "");
  return norm(a) === norm(b);
}
