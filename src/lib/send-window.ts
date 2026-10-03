// Send-time windows for automations: which weekdays and hours (in one timezone) an email step may go out.
// Pure functions only, so they are easy to test and have no database dependency.

export type SendWindow = {
  /** Allowed weekdays, 0 = Sunday ... 6 = Saturday. */
  days: number[];
  /** First allowed hour of the day, 0-23. */
  startHour: number;
  /** Hour the window closes, 1-24 (exclusive): 9 to 17 allows 09:00 up to 16:59. */
  endHour: number;
  /** IANA timezone name, for example "UTC" or "America/New_York". */
  timezone: string;
};

export const DEFAULT_TIMEZONE = "UTC";
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Timezone names for a picker. "UTC" is first because Intl does not always list it. */
export function timeZoneOptions(): string[] {
  const names = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [DEFAULT_TIMEZONE, ...names.filter((name) => name !== DEFAULT_TIMEZONE)];
}

/** "1,2,3" -> [1, 2, 3]. Ignores anything that is not a weekday number. */
export function parseDays(value: string): number[] {
  return normalizeDays(
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(Number),
  );
}

export function normalizeDays(days: number[]): number[] {
  return [...new Set(days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
}

export function serializeDays(days: number[]): string {
  return normalizeDays(days).join(",");
}

/** Throws a readable message when the window cannot work. Returns the cleaned window. */
export function validateWindow(input: SendWindow): SendWindow {
  const days = normalizeDays(input.days);
  if (days.length === 0) throw new Error("Choose at least one day to send on.");
  if (!Number.isInteger(input.startHour) || input.startHour < 0 || input.startHour > 23) {
    throw new Error("Start hour must be between 0 and 23.");
  }
  if (!Number.isInteger(input.endHour) || input.endHour < 1 || input.endHour > 24) {
    throw new Error("End hour must be between 1 and 24.");
  }
  if (input.endHour <= input.startHour) throw new Error("The window must end after it starts.");
  if (!isValidTimeZone(input.timezone)) throw new Error("Choose a valid timezone.");
  return { days, startHour: input.startHour, endHour: input.endHour, timezone: input.timezone };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function localParts(date: Date, timezone: string): { day: number; hour: number; minute: number; second: number } {
  const parts = formatterFor(timezone).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    day: WEEKDAY_INDEX[read("weekday")] ?? 0,
    hour: Number(read("hour")) % 24,
    minute: Number(read("minute")),
    second: Number(read("second")),
  };
}

export function isInWindow(date: Date, window: SendWindow): boolean {
  const local = localParts(date, window.timezone);
  return window.days.includes(local.day) && local.hour >= window.startHour && local.hour < window.endHour;
}

/**
 * The first moment at or after `from` that falls inside the window, or null when no day is allowed.
 * Moves forward to hour boundaries and re-checks each time, so daylight-saving changes need no special case.
 */
export function nextAllowedTime(from: Date, window: SendWindow): Date | null {
  if (window.days.length === 0) return null;
  let current = from;
  // 14 days of day-jumps is far more than any valid window needs; it only guards against an endless loop.
  for (let step = 0; step < 14 * 4; step += 1) {
    const local = localParts(current, window.timezone);
    const allowedDay = window.days.includes(local.day);
    if (allowedDay && local.hour >= window.startHour && local.hour < window.endHour) return current;
    const hoursToSkip = allowedDay && local.hour < window.startHour ? window.startHour - local.hour : 24 - local.hour;
    // Land exactly on the hour: take off the minutes, seconds, and milliseconds already elapsed.
    const elapsedMs = (local.minute * 60 + local.second) * 1000 + current.getMilliseconds();
    current = new Date(current.getTime() + hoursToSkip * 3_600_000 - elapsedMs);
  }
  return null;
}
