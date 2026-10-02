import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, calendarWeeks, weekStart } from "../src/week-calendar";

test("exact five months with continuous Monday-first rows and complete cross-month week", () => {
  const calendar = calendarWeeks("2026-10-02");
  assert.equal(calendar.first, "2026-08-01");
  assert.equal(calendar.last, "2026-12-31");
  const dates = calendar.rows.flatMap(row => row.dates).filter(Boolean);
  assert.equal(dates[0], calendar.first);
  assert.equal(dates.at(-1), calendar.last);
  assert.equal(new Set(dates).size, 153);
  calendar.rows.forEach((row, i) => {
    assert.equal(weekStart(row.start), row.start);
    if (i) assert.equal(row.start, addDays(calendar.rows[i - 1]!.start, 7));
  });
  assert.deepEqual(calendar.rows.find(row => row.start === "2026-09-28")?.dates,
    ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(calendar.rows.flatMap(row => row.months), ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
});
test("year rollover and leap days stay within bounds", () => {
  const calendar = calendarWeeks("2024-01-15");
  assert.equal(calendar.first, "2023-11-01");
  assert.equal(calendar.last, "2024-03-31");
  assert.ok(calendar.rows.some(row => row.dates.includes("2024-02-29")));
  assert.equal(weekStart("2024-01-07"), "2024-01-01");
});
