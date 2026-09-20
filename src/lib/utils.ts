import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMoney(value: string | number | null | undefined) {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(n);
}

/** Format a YYYY-MM-DD date column value (no timezone shifting). */
export function formatDateOnly(value: string | null | undefined) {
  if (!value) return "";
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * On the server, render in the app timezone (APP_TIMEZONE); in the browser, use the viewer's
 * local timezone. `process.env.APP_TIMEZONE` is not inlined into client bundles, so it is
 * undefined there and the browser default applies.
 */
const SERVER_TIMEZONE = typeof window === "undefined" ? process.env.APP_TIMEZONE : undefined;

export function formatDateTime(value: Date | string | null | undefined, timeZone: string | undefined = SERVER_TIMEZONE) {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("en-NZ", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function emptyToNull(v: FormDataEntryValue | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
