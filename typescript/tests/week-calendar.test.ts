import assert from "node:assert/strict";
import test from "node:test";
import { calendarWeeks, mondayOf } from "../src/week-calendar";

test("week rows are continuous Monday-first ranges across months", () => {
  const weeks = calendarWeeks("2026-10-02");
  assert.equal(weeks[0].start, "2026-07-27");
  for (const [index, week] of weeks.entries()) {
    assert.equal(week.dates.length, 7);
    assert.equal(week.dates[0], week.start);
    assert.equal(new Date(`${week.start}T12:00:00Z`).getUTCDay(), 1);
    for (let day = 1; day < week.dates.length; day++) {
      const prior = new Date(`${week.dates[day - 1]}T12:00:00Z`);
      prior.setUTCDate(prior.getUTCDate() + 1);
      assert.equal(week.dates[day], prior.toISOString().slice(0, 10));
    }
    if (index) {
      const prior = new Date(`${weeks[index - 1].start}T12:00:00Z`);
      prior.setUTCDate(prior.getUTCDate() + 7);
      assert.equal(week.start, prior.toISOString().slice(0, 10));
    }
  }
  const boundary = weeks.find((week) => week.dates.includes("2026-11-01"))!;
  assert.deepEqual(boundary.dates, ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
});

test("picker labels only the current month plus or minus two months", () => {
  const weeks = calendarWeeks("2026-11-18");
  assert.deepEqual(weeks.map((week) => week.monthLabel).filter(Boolean), [
    "September", "October", "November", "December", "January 2027",
  ]);
  assert.equal(weeks.some((week) => week.monthLabel.includes("February")), false);
  assert.equal(weeks.some((week) => week.monthLabel.includes("August")), false);
});

test("week selection normalizes dates to Monday", () => {
  assert.equal(mondayOf("2026-10-02"), "2026-09-28");
  assert.equal(mondayOf("2026-10-05"), "2026-10-05");
});
