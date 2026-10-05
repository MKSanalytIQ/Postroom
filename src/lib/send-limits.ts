import { readySql } from "./sql";
import { nowIso } from "./time";
import { UserError } from "./user-error";

export type SendLimits = {
  perSecond: number;
  perMinute: number;
  perHour: number;
  perDay: number;
};

export const DEFAULT_SEND_LIMITS: SendLimits = {
  perSecond: 2,
  perMinute: 60,
  perHour: 1000,
  perDay: 10_000,
};

const BUCKETS: { name: "s" | "m" | "h" | "d"; key: keyof SendLimits; ms: number }[] = [
  { name: "s", key: "perSecond", ms: 1_000 },
  { name: "m", key: "perMinute", ms: 60_000 },
  { name: "h", key: "perHour", ms: 3_600_000 },
  { name: "d", key: "perDay", ms: 86_400_000 },
];

function floorWindow(ms: number, size: number): string {
  return new Date(Math.floor(ms / size) * size).toISOString();
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function getSendLimits(userId: string): Promise<SendLimits> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT per_second, per_minute, per_hour, per_day FROM send_limits WHERE user_id = ?")
    .get(userId)) as { per_second: number; per_minute: number; per_hour: number; per_day: number } | null;
  if (!row) return { ...DEFAULT_SEND_LIMITS };
  return {
    perSecond: Number(row.per_second),
    perMinute: Number(row.per_minute),
    perHour: Number(row.per_hour),
    perDay: Number(row.per_day),
  };
}

export async function saveSendLimits(userId: string, input: Partial<SendLimits>): Promise<SendLimits> {
  const current = await getSendLimits(userId);
  const next: SendLimits = {
    perSecond: clamp(input.perSecond ?? current.perSecond, 1, 50),
    perMinute: clamp(input.perMinute ?? current.perMinute, 1, 6_000),
    perHour: clamp(input.perHour ?? current.perHour, 1, 100_000),
    perDay: clamp(input.perDay ?? current.perDay, 1, 1_000_000),
  };
  if (next.perMinute < next.perSecond) throw new UserError("Per-minute limit must be at least the per-second limit.");
  if (next.perHour < next.perMinute) throw new UserError("Per-hour limit must be at least the per-minute limit.");
  if (next.perDay < next.perHour) throw new UserError("Per-day limit must be at least the per-hour limit.");
  const sql = await readySql();
  await sql
    .prepare(
      `INSERT INTO send_limits (user_id, per_second, per_minute, per_hour, per_day, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         per_second = excluded.per_second,
         per_minute = excluded.per_minute,
         per_hour = excluded.per_hour,
         per_day = excluded.per_day,
         updated_at = excluded.updated_at`,
    )
    .run(userId, next.perSecond, next.perMinute, next.perHour, next.perDay, nowIso());
  return next;
}

/** How many more messages this account may send right now (min across all windows). */
export async function remainingSendCapacity(userId: string): Promise<number> {
  const limits = await getSendLimits(userId);
  const sql = await readySql();
  const now = Date.now();
  let remaining = Number.POSITIVE_INFINITY;
  for (const bucket of BUCKETS) {
    const start = floorWindow(now, bucket.ms);
    const row = (await sql
      .prepare("SELECT count FROM send_counters WHERE user_id = ? AND bucket = ? AND window_start = ?")
      .get(userId, bucket.name, start)) as { count: number } | null;
    const used = Number(row?.count ?? 0);
    const cap = limits[bucket.key];
    remaining = Math.min(remaining, Math.max(0, cap - used));
  }
  return remaining === Number.POSITIVE_INFINITY ? 0 : remaining;
}

/**
 * Reserves one send slot for the account if capacity remains.
 * Returns false when any window is exhausted (caller should leave the recipient pending).
 */
export async function tryReserveSend(userId: string): Promise<boolean> {
  if (process.env.POSTROOM_DISABLE_SEND_LIMITS === "1") return true;
  const sql = await readySql();
  const limits = await getSendLimits(userId);
  const now = Date.now();
  return sql.transaction(async (tx) => {
    for (const bucket of BUCKETS) {
      const start = floorWindow(now, bucket.ms);
      const row = (await tx
        .prepare("SELECT count FROM send_counters WHERE user_id = ? AND bucket = ? AND window_start = ?")
        .get(userId, bucket.name, start)) as { count: number } | null;
      if (Number(row?.count ?? 0) >= limits[bucket.key]) return false;
    }
    for (const bucket of BUCKETS) {
      const start = floorWindow(now, bucket.ms);
      await tx
        .prepare(
          `INSERT INTO send_counters (user_id, bucket, window_start, count) VALUES (?, ?, ?, 1)
           ON CONFLICT (user_id, bucket, window_start) DO UPDATE SET count = send_counters.count + 1`,
        )
        .run(userId, bucket.name, start);
    }
    // Best-effort prune of very old day windows.
    await tx.prepare("DELETE FROM send_counters WHERE window_start < ?").run(new Date(now - 8 * 86_400_000).toISOString());
    return true;
  });
}
