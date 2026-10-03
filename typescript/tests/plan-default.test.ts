import assert from "node:assert/strict";
import test from "node:test";
import { defaultPlanPlacement } from "../src/plan-default";
import type { Card, Slot } from "../src/types";

const slots: Slot[] = [
  { id: "dinner", name: "Dinner", time: "19:00" },
  { id: "breakfast", name: "Breakfast", time: "08:00" },
  { id: "lunch", name: "Lunch", time: "13:00" },
];
function card(date: string, time: string, extra: Partial<Card> = {}): Card {
  return {
    id: `meal-${date}-${time}`,
    projectId: "fake-project",
    name: "Synthetic meal",
    date,
    time,
    requestId: "synthetic-request",
    state: "saved",
    error: "",
    confirmedAt: 0,
    ...extra,
  };
}

test("Plan uses the exact current slot cutoff and skips earlier times", () => {
  const result = defaultPlanPlacement("2026-10-05", slots, [], new Date("2026-10-07T12:30:00Z"));
  assert.deepEqual(result, { date: "2026-10-07", slotId: "dinner" });
  const exact = defaultPlanPlacement("2026-10-05", [{ id: "at-cutoff", name: "Cutoff", time: "18:00" }], [], new Date("2026-10-07T12:30:00Z"));
  assert.deepEqual(exact, { date: "2026-10-07", slotId: "at-cutoff" });
});

test("occupied slots are skipped, including pending creations and deletes", () => {
  const cards = [
    card("2026-10-07", "19:00", { state: "pending", id: "local:create" }),
    card("2026-10-08", "08:00", { state: "pending", deleting: true, id: "remote:delete" }),
  ];
  assert.deepEqual(
    defaultPlanPlacement("2026-10-05", slots, cards, new Date("2026-10-07T12:30:00Z")),
    { date: "2026-10-08", slotId: "lunch" },
  );
});

test("slot identity keeps a renamed-time card in its occupied cell", () => {
  assert.deepEqual(
    defaultPlanPlacement(
      "2026-10-07",
      [{ id: "dinner", name: "Dinner", time: "19:00" }],
      [card("2026-10-07", "18:30", { slotId: "dinner" })],
      new Date("2026-10-07T11:00:00Z"),
    ),
    { date: "2026-10-08", slotId: "dinner" },
  );
});

test("future, past and full viewed weeks do not claim an unavailable global default", () => {
  assert.equal(
    defaultPlanPlacement("2026-10-12", slots, [], new Date("2026-10-07T12:30:00Z")),
    null,
  );
  assert.equal(
    defaultPlanPlacement("2026-09-28", slots, [], new Date("2026-10-07T12:30:00Z")),
    null,
  );
  const fullWeek = Array.from({ length: 21 }, (_, index) => {
    const date = new Date("2026-10-05T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + Math.floor(index / 3));
    return card(date.toISOString().slice(0, 10), ["08:00", "13:00", "19:00"][index % 3]);
  });
  assert.equal(
    defaultPlanPlacement("2026-10-05", slots, fullWeek, new Date("2026-10-07T12:30:00Z")),
    null,
  );
});

test("Asia/Kolkata time is used across browser UTC midnight and week rollover", () => {
  const rolloverSlots: Slot[] = [
    { id: "midnight", name: "Midnight", time: "00:00" },
    { id: "after-midnight", name: "After midnight", time: "00:15" },
  ];
  assert.deepEqual(
    defaultPlanPlacement("2026-10-05", rolloverSlots, [], new Date("2026-10-04T18:35:00Z")),
    { date: "2026-10-05", slotId: "after-midnight" },
  );
  assert.deepEqual(
    defaultPlanPlacement("2026-10-12", rolloverSlots, [], new Date("2026-10-11T18:30:00Z")),
    { date: "2026-10-12", slotId: "midnight" },
  );
});

test("slot order is chronological even when configuration order is not", () => {
  assert.deepEqual(
    defaultPlanPlacement("2026-10-05", slots, [], new Date("2026-10-05T00:00:00Z")),
    { date: "2026-10-05", slotId: "breakfast" },
  );
});
