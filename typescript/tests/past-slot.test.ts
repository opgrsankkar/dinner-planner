import test from "node:test";
import assert from "node:assert/strict";
import { isPastSlot } from "../src/past-slot";

// All instants are given in UTC and interpreted with the Asia/Kolkata offset.
const ist = (value: string) => new Date(value);

test("a slot is past only after its own minute has fully elapsed", () => {
  const date = "2026-10-16";
  assert.equal(isPastSlot(date, "08:00", ist("2026-10-16T02:29:59Z")), false);
  // 08:00:00 IST is still the slot's own minute, matching the planner cutoff.
  assert.equal(isPastSlot(date, "08:00", ist("2026-10-16T02:30:00Z")), false);
  assert.equal(isPastSlot(date, "08:00", ist("2026-10-16T02:30:59Z")), false);
  assert.equal(isPastSlot(date, "08:00", ist("2026-10-16T02:31:00Z")), true);
});

test("same-day earlier meals count as past, later meals stay future", () => {
  const now = ist("2026-10-16T03:30:00Z"); // 09:00 IST
  assert.equal(isPastSlot("2026-10-16", "08:00", now), true);
  assert.equal(isPastSlot("2026-10-16", "09:00", now), false);
  assert.equal(isPastSlot("2026-10-16", "13:00", now), false);
  assert.equal(isPastSlot("2026-10-17", "08:00", now), false);
  assert.equal(isPastSlot("2026-10-15", "23:00", now), true);
});

test("Asia/Kolkata time is used across the UTC midnight boundary", () => {
  // 18:30Z is exactly IST midnight on the next calendar day.
  assert.equal(
    isPastSlot("2026-10-16", "00:00", ist("2026-10-15T18:29:59Z")),
    false,
  );
  assert.equal(
    isPastSlot("2026-10-16", "00:00", ist("2026-10-15T18:30:00Z")),
    false,
  );
  assert.equal(
    isPastSlot("2026-10-16", "00:00", ist("2026-10-15T18:31:00Z")),
    true,
  );
  // A late slot on the previous IST day is past even though UTC is still that day.
  assert.equal(
    isPastSlot("2026-10-15", "23:30", ist("2026-10-15T18:30:00Z")),
    true,
  );
});

test("date-only or invalid slots are never treated as past", () => {
  const now = ist("2026-10-16T03:30:00Z");
  assert.equal(isPastSlot("2026-10-16", "", now), false);
  assert.equal(isPastSlot("2026-10-16", "25:00", now), false);
  assert.equal(isPastSlot("2026-02-30", "08:00", now), false);
  assert.equal(isPastSlot("not-a-date", "08:00", now), false);
});
