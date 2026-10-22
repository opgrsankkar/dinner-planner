import { test } from "node:test";
import assert from "node:assert/strict";
import { mealsCalendar } from "../src/server/calendar";
import type { Card, Slot } from "../src/types";

const slots: Slot[] = [{ id: "s1", name: "Dinner", time: "19:00" }];
const card = (overrides: Partial<Card>): Card => ({
  id: "m1", projectId: "local-meals", name: "Idli, sambar; chutney", date: "2026-10-22", time: "19:00",
  requestId: "r1", state: "saved", error: "", confirmedAt: 1, slotId: "s1", ...overrides,
});

test("calendar converts IST slots to UTC events and escapes text", () => {
  const text = mealsCalendar([card({})], slots, new Date("2026-10-22T06:00:00Z"));
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.match(text, /DTSTART:20261022T133000Z\r\n/);
  assert.match(text, /DTEND:20261022T140000Z\r\n/);
  assert.ok(text.includes("SUMMARY:Dinner · Idli\\, sambar\\; chutney\r\n"), text);
  assert.match(text, /UID:m1@meals\.x1c/);
});

test("calendar skips pending, deleting, undated and out-of-window meals", () => {
  const now = new Date("2026-10-22T06:00:00Z");
  const text = mealsCalendar([
    card({ id: "pending", state: "pending" }),
    card({ id: "deleting", deleting: true }),
    card({ id: "undated", time: "" }),
    card({ id: "old", date: "2026-09-01" }),
    card({ id: "far", date: "2027-06-01" }),
    card({ id: "kept", date: "2026-10-30" }),
  ], slots, now);
  assert.deepEqual([...text.matchAll(/UID:([^@]+)@/g)].map((m) => m[1]), ["kept"]);
});

test("calendar folds long lines at 75 octets", () => {
  const text = mealsCalendar([card({ name: "A very long meal name ".repeat(6) })], slots, new Date("2026-10-22T06:00:00Z"));
  for (const line of text.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.match(text, /\r\n /);
});
