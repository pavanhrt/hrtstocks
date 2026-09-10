import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNseTradingDay,
  latestCompletedNseSession,
  hourlyBarBoundaries,
  isCompletedHourlyBoundary,
  HOURLY_STUB_POLICY,
} from "./nse-calendar.js";

test("isNseTradingDay rejects Saturday and Sunday", () => {
  assert.equal(isNseTradingDay("2026-09-12"), false); // Saturday
  assert.equal(isNseTradingDay("2026-09-13"), false); // Sunday
});

test("isNseTradingDay rejects a listed holiday (Republic Day)", () => {
  assert.equal(isNseTradingDay("2026-01-26"), false);
});

test("isNseTradingDay accepts an ordinary weekday", () => {
  assert.equal(isNseTradingDay("2026-09-10"), true); // Thursday, not a holiday
});

test("isNseTradingDay returns null (never guesses) for a year with no loaded holiday list", () => {
  assert.equal(isNseTradingDay("2030-01-02"), null);
});

test("latestCompletedNseSession returns today when called well after close on a trading day", () => {
  // 2026-09-10 is a Thursday, not a holiday. 18:00 IST = 12:30 UTC.
  const afterClose = new Date("2026-09-10T12:30:00Z");
  assert.equal(latestCompletedNseSession(afterClose), "2026-09-10");
});

test("latestCompletedNseSession returns the prior trading day when called before close", () => {
  // 10:00 IST = 04:30 UTC -- session is still open.
  const duringSession = new Date("2026-09-10T04:30:00Z");
  assert.equal(latestCompletedNseSession(duringSession), "2026-09-09");
});

test("latestCompletedNseSession skips weekends", () => {
  // Monday 2026-09-14 at 04:00 UTC (09:30 IST, still in session) -> latest
  // completed session must be Friday 2026-09-11, not the weekend.
  const mondayMorning = new Date("2026-09-14T04:00:00Z");
  assert.equal(latestCompletedNseSession(mondayMorning), "2026-09-11");
});

test("latestCompletedNseSession skips a holiday that falls on a weekday", () => {
  // 2026-01-27 (Tuesday) at 12:30 UTC (18:00 IST, after close). 2026-01-26
  // (Republic Day, Monday) is a holiday, so the latest completed session
  // before today's close should be 2026-01-23 (Friday) once we walk back
  // past both the holiday and the weekend -- but since today itself
  // (2026-01-27) is past close and a trading day, today is the answer.
  // Use 2026-01-26 itself (a holiday) to force the walk-back logic.
  const onTheHoliday = new Date("2026-01-26T12:30:00Z");
  assert.equal(latestCompletedNseSession(onTheHoliday), "2026-01-23");
});

test("hourlyBarBoundaries returns exactly 6 full-hour windows covering 09:15-15:15", () => {
  const bounds = hourlyBarBoundaries();
  assert.equal(bounds.length, 6);
  assert.equal(bounds[0].start, "09:15");
  assert.equal(bounds[5].end, "15:15");
});

test("hourlyBarBoundaries excludes the trailing 15:15-15:30 stub, per the disclosed policy", () => {
  const bounds = hourlyBarBoundaries();
  assert.ok(!bounds.some((b) => b.end === "15:30"));
  assert.equal(HOURLY_STUB_POLICY, "exclude");
});

test("isCompletedHourlyBoundary accepts a real hourly close and rejects the excluded stub", () => {
  assert.equal(isCompletedHourlyBoundary("10:15"), true);
  assert.equal(isCompletedHourlyBoundary("15:15"), true);
  assert.equal(isCompletedHourlyBoundary("15:30"), false); // the stub -- never a valid trigger close
  assert.equal(isCompletedHourlyBoundary("10:00"), false); // not a boundary at all
});
