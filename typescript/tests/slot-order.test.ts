import { test } from "node:test";
import assert from "node:assert/strict";
import { sortSlotsByTime } from "../src/slot-order";
const slot = (id: string, time: string) => ({ id, name: id, time });
test("slot times sort chronologically without mutating IDs or input", () => {
  const slots = [slot("dinner", "19:00"), slot("midnight", "00:00"), slot("breakfast", "08:00")];
  assert.deepEqual(sortSlotsByTime(slots).map(s => s.id), ["midnight", "breakfast", "dinner"]);
  assert.equal(slots[0].id, "dinner");
});
test("equal times retain draft order deterministically", () => {
  const slots = [slot("second", "13:00"), slot("first", "13:00"), slot("early", "08:00")];
  assert.deepEqual(sortSlotsByTime(slots).map(s => s.id), ["early", "second", "first"]);
});
test("any partial or invalid time freezes the entire order", () => {
  for (const time of ["", "1", "12:", "24:00", "09:99"]) {
    const slots = [slot("late", "19:00"), slot("partial", time), slot("early", "08:00")];
    assert.strictEqual(sortSlotsByTime(slots), slots);
  }
});
