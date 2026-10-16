import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryDragPreview, sameLibraryDragPreview } from "../src/drag-preview";

test("library drag preview carries the meal into the hovered date and slot", () => {
  assert.deepEqual(libraryDragPreview({ name: "Dal & rice" }, "2026-10-19", "slot-lunch"), {
    date: "2026-10-19",
    slotId: "slot-lunch",
    name: "Dal & rice",
  });
});

test("no preview for the unassigned row or a missing meal", () => {
  assert.equal(libraryDragPreview({ name: "Dal & rice" }, "2026-10-19", "unassigned"), null);
  assert.equal(libraryDragPreview(null, "2026-10-19", "slot-lunch"), null);
});

test("repeated dragover in the same cell does not churn the preview", () => {
  const preview = libraryDragPreview({ name: "Idli & sambar" }, "2026-10-19", "slot-breakfast");
  assert.ok(sameLibraryDragPreview(preview, { date: "2026-10-19", slotId: "slot-breakfast", name: "Idli & sambar" }));
  assert.ok(!sameLibraryDragPreview(preview, { date: "2026-10-19", slotId: "slot-lunch", name: "Idli & sambar" }));
  assert.ok(!sameLibraryDragPreview(preview, { date: "2026-10-20", slotId: "slot-breakfast", name: "Idli & sambar" }));
  assert.ok(!sameLibraryDragPreview(preview, { date: "2026-10-19", slotId: "slot-breakfast", name: "Dal & rice" }));
  assert.ok(sameLibraryDragPreview(null, null));
  assert.ok(!sameLibraryDragPreview(preview, null));
  assert.ok(!sameLibraryDragPreview(null, preview));
});
