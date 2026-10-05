// A small in-memory fixed-window limiter for the webhook endpoint. It is per process: good enough to
// blunt token guessing and floods on one server, not a shared quota across several instances.

export type RateLimiter = {
  /** Counts one event for the key and says whether it is still within the limit. */
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
  /** True when the key has already used up its allowance (does not count). */
  blocked(key: string): { blocked: boolean; retryAfterSeconds: number };
  reset(): void;
};

export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  const MAX_KEYS = 5000;

  function current(key: string): { start: number; count: number } {
    const time = now();
    const found = windows.get(key);
    if (found && time - found.start < windowMs) return found;
    if (windows.size >= MAX_KEYS) {
      for (const [other, entry] of windows) if (time - entry.start >= windowMs) windows.delete(other);
      if (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value as string);
    }
    const fresh = { start: time, count: 0 };
    windows.set(key, fresh);
    return fresh;
  }

  const retry = (entry: { start: number }) => Math.max(1, Math.ceil((entry.start + windowMs - now()) / 1000));

  return {
    take(key) {
      const entry = current(key);
      entry.count += 1;
      return { allowed: entry.count <= limit, retryAfterSeconds: retry(entry) };
    },
    blocked(key) {
      const entry = current(key);
      return { blocked: entry.count >= limit, retryAfterSeconds: retry(entry) };
    },
    reset() {
      windows.clear();
    },
  };
}
