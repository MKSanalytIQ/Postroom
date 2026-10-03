import assert from "node:assert/strict";
import test from "node:test";
import {
  isInWindow,
  isValidTimeZone,
  nextAllowedTime,
  parseDays,
  serializeDays,
  timeZoneOptions,
  validateWindow,
  type SendWindow,
} from "./send-window";

const WEEKDAYS_9_TO_5: SendWindow = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, timezone: "UTC" };

function next(iso: string, window: SendWindow): string | null {
  return nextAllowedTime(new Date(iso), window)?.toISOString() ?? null;
}

test("a time inside the window is returned unchanged", () => {
  // 2026-10-07 is a Wednesday.
  assert.equal(next("2026-10-07T10:15:30.250Z", WEEKDAYS_9_TO_5), "2026-10-07T10:15:30.250Z");
  assert.equal(next("2026-10-07T09:00:00.000Z", WEEKDAYS_9_TO_5), "2026-10-07T09:00:00.000Z");
  assert.equal(isInWindow(new Date("2026-10-07T16:59:59Z"), WEEKDAYS_9_TO_5), true);
  assert.equal(isInWindow(new Date("2026-10-07T17:00:00Z"), WEEKDAYS_9_TO_5), false);
});

test("a time outside the window moves to the next opening, on the hour", () => {
  assert.equal(next("2026-10-07T08:30:45.123Z", WEEKDAYS_9_TO_5), "2026-10-07T09:00:00.000Z", "before opening, same day");
  assert.equal(next("2026-10-07T17:00:00.000Z", WEEKDAYS_9_TO_5), "2026-10-08T09:00:00.000Z", "after closing, next day");
  assert.equal(next("2026-10-09T17:30:00.000Z", WEEKDAYS_9_TO_5), "2026-10-12T09:00:00.000Z", "Friday evening to Monday");
  assert.equal(next("2026-10-03T12:00:00.000Z", WEEKDAYS_9_TO_5), "2026-10-05T09:00:00.000Z", "Saturday to Monday");
  assert.equal(next("2026-10-04T00:00:00.000Z", WEEKDAYS_9_TO_5), "2026-10-05T09:00:00.000Z", "Sunday to Monday");
});

test("windows use their own timezone, including across a daylight-saving change", () => {
  const india: SendWindow = { ...WEEKDAYS_9_TO_5, timezone: "Asia/Kolkata" };
  // Friday 17:30 IST -> Monday 09:00 IST (03:30 UTC).
  assert.equal(next("2026-10-09T12:00:00.000Z", india), "2026-10-12T03:30:00.000Z");
  // Wednesday 03:00 UTC is 08:30 IST, so it waits until 09:00 IST.
  assert.equal(next("2026-10-07T03:00:00.000Z", india), "2026-10-07T03:30:00.000Z");
  const newYork: SendWindow = { ...WEEKDAYS_9_TO_5, timezone: "America/New_York" };
  // US clocks go back on 2026-11-01. Sunday 07:00 EST -> Monday 09:00 EST = 14:00 UTC.
  assert.equal(next("2026-11-01T12:00:00.000Z", newYork), "2026-11-02T14:00:00.000Z");
  // The week before (still EDT) Monday 09:00 EDT = 13:00 UTC.
  assert.equal(next("2026-10-25T12:00:00.000Z", newYork), "2026-10-26T13:00:00.000Z");
});

test("single day, full-day, and impossible windows", () => {
  const tuesdayOnly: SendWindow = { days: [2], startHour: 0, endHour: 24, timezone: "UTC" };
  assert.equal(next("2026-10-07T12:00:00.000Z", tuesdayOnly), "2026-10-13T00:00:00.000Z");
  assert.equal(next("2026-10-13T23:59:59.000Z", tuesdayOnly), "2026-10-13T23:59:59.000Z");
  assert.equal(next("2026-10-07T12:00:00.000Z", { ...tuesdayOnly, days: [] }), null);
});

test("window validation and day parsing", () => {
  assert.deepEqual(validateWindow({ ...WEEKDAYS_9_TO_5, days: [5, 1, 1, 9, -1, 3] }).days, [1, 3, 5]);
  assert.throws(() => validateWindow({ ...WEEKDAYS_9_TO_5, days: [] }), /at least one day/);
  assert.throws(() => validateWindow({ ...WEEKDAYS_9_TO_5, startHour: 17, endHour: 9 }), /end after/);
  assert.throws(() => validateWindow({ ...WEEKDAYS_9_TO_5, startHour: 9, endHour: 9 }), /end after/);
  assert.throws(() => validateWindow({ ...WEEKDAYS_9_TO_5, startHour: 24 }), /Start hour/);
  assert.throws(() => validateWindow({ ...WEEKDAYS_9_TO_5, endHour: 25 }), /End hour/);
  assert.throws(() => validateWindow({ ...WEEKDAYS_9_TO_5, timezone: "Mars/Olympus" }), /timezone/);
  assert.equal(isValidTimeZone("Europe/London"), true);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone("Nope"), false);
  assert.deepEqual(parseDays("1, 2,x,7,5"), [1, 2, 5]);
  assert.equal(serializeDays([3, 1, 3]), "1,3");
  assert.equal(timeZoneOptions()[0], "UTC");
  assert.ok(timeZoneOptions().includes("Europe/London"));
  assert.deepEqual(parseDays(""), []);
});
