import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// #78: desktop (fine pointer) gets quiet, compact edit/delete actions and is
// never shown the touch swipe hint; touch-first devices keep swipe + hint.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../src/settings/MealLibrarySettings.css"), "utf8");
const row = readFileSync(join(here, "../src/settings/SwipeMealRow.tsx"), "utf8");

function mediaBlock(source: string, query: string) {
  const start = source.indexOf(`@media ${query}`);
  assert.notEqual(start, -1, `expected @media ${query}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unterminated @media ${query}`);
}

test("the swipe reveal is gated to touch-first devices, not all hover devices", () => {
  assert.ok(css.includes("@media (hover: none), (pointer: coarse)"), "focus reveal is touch-gated");
  assert.ok(css.includes("@media (hover: hover) and (pointer: coarse)"), "hover reveal requires a coarse primary pointer");
  assert.doesNotMatch(css, /@media\s*\(hover:\s*hover\)\s*\{/, "no unqualified hover reveal remains");
});

test("fine-pointer desktops get compact, blended, right-aligned actions", () => {
  const desktop = mediaBlock(css, "(hover: hover) and (pointer: fine)");
  assert.match(desktop, /position:\s*static/, "actions flow inline instead of sliding");
  assert.match(desktop, /background:\s*transparent/, "action background blends into the row");
  assert.match(desktop, /opacity:\s*\.5/, "actions are quiet until hover/focus");
  assert.match(desktop, /\.folio-library-edit\s*\{\s*order:\s*1/, "edit icon sits first on the right");
  assert.match(desktop, /\.folio-library-remove\s*\{\s*order:\s*2/, "trash icon sits last on the right");
  assert.match(desktop, /background:\s*color-mix/, "hover/focus adds only a subtle highlight");
});

test("swipe gestures and the hint are capability-gated in the row component", () => {
  assert.ok(row.includes('event.pointerType !== "touch"'), "mouse drag does not swipe the row");
  assert.ok(row.includes("!hint || !coarsePointer"), "swipe hint is gated on a coarse pointer");
});
