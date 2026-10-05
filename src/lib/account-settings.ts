import { readySql } from "./sql";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "./send-window";
import { nowIso } from "./time";
import { UserError } from "./user-error";

export type AccountSettings = {
  timezone: string;
  softBounceThreshold: number;
  softBounceWindowDays: number;
};

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  timezone: DEFAULT_TIMEZONE,
  softBounceThreshold: 3,
  softBounceWindowDays: 30,
};

export async function getAccountSettings(userId: string): Promise<AccountSettings> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT timezone, soft_bounce_threshold, soft_bounce_window_days FROM account_settings WHERE user_id = ?")
    .get(userId)) as
    | { timezone: string; soft_bounce_threshold: number; soft_bounce_window_days: number }
    | null;
  if (!row) return { ...DEFAULT_ACCOUNT_SETTINGS };
  return {
    timezone: isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE,
    softBounceThreshold: Math.max(1, Number(row.soft_bounce_threshold) || 3),
    softBounceWindowDays: Math.max(1, Number(row.soft_bounce_window_days) || 30),
  };
}

export async function saveAccountSettings(
  userId: string,
  input: Partial<AccountSettings>,
): Promise<AccountSettings> {
  const current = await getAccountSettings(userId);
  const timezone = input.timezone ?? current.timezone;
  if (!isValidTimeZone(timezone)) throw new UserError("Choose a valid timezone.");
  const softBounceThreshold = input.softBounceThreshold ?? current.softBounceThreshold;
  const softBounceWindowDays = input.softBounceWindowDays ?? current.softBounceWindowDays;
  if (!Number.isInteger(softBounceThreshold) || softBounceThreshold < 1 || softBounceThreshold > 100) {
    throw new UserError("Soft-bounce threshold must be between 1 and 100.");
  }
  if (!Number.isInteger(softBounceWindowDays) || softBounceWindowDays < 1 || softBounceWindowDays > 365) {
    throw new UserError("Soft-bounce window must be between 1 and 365 days.");
  }
  const sql = await readySql();
  const now = nowIso();
  await sql
    .prepare(
      `INSERT INTO account_settings (user_id, timezone, soft_bounce_threshold, soft_bounce_window_days, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET timezone = excluded.timezone,
         soft_bounce_threshold = excluded.soft_bounce_threshold,
         soft_bounce_window_days = excluded.soft_bounce_window_days,
         updated_at = excluded.updated_at`,
    )
    .run(userId, timezone, softBounceThreshold, softBounceWindowDays, now);
  return { timezone, softBounceThreshold, softBounceWindowDays };
}
