/**
 * Small in-memory limiter for login attempts (per process). Enough to blunt password guessing on a
 * single-instance deployment; put a WAF or edge rate limit in front for anything bigger.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

export function checkLoginAllowed(key: string): { allowed: boolean; retryAfterMinutes: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) return { allowed: true, retryAfterMinutes: 0 };
  return { allowed: b.count < MAX_ATTEMPTS, retryAfterMinutes: Math.ceil((b.resetAt - now) / 60_000) };
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else b.count++;
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}

export function clearLoginFailures(key: string) {
  buckets.delete(key);
}
