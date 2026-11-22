import assert from "node:assert/strict";
import { test } from "node:test";
import { scaleAmount, sourceServings } from "../src/recipes/servings";

test("only unambiguous numeric source servings enable scaling", () => {
  for (const value of ["", "3 large rolls", "serves 4", "2–4", "0", "-4", "NaN", "Infinity"]) assert.equal(sourceServings(value), null, value);
  assert.equal(sourceServings(" 4 "), 4);
  assert.equal(sourceServings("2.5"), 2.5);
});

test("leading quantities: decimals, Unicode, mixed fractions, ranges and unitless eggs", () => {
  for (const [input, expected] of [
    ["4", "2"], ["400g", "200g"], ["1.5 cups", "3/4 cups"],
    ["½ cup", "1/4 cup"], ["1½ cups", "3/4 cups"], ["1 ½ cups", "3/4 cups"],
    ["1 1/2 cups", "3/4 cups"], ["1 / 2 tsp", "1/4 tsp"], ["⅔ cup", "1/3 cup"],
    ["2–4 tbsp", "1–2 tbsp"], ["2 - 4 tbsp", "1 - 2 tbsp"], ["2 to 4", "1 to 2"],
    ["2 (400g cans)", "1 (400g cans)"], ["2 cups, divided into 3 bowls", "1 cups, divided into 3 bowls"],
    [".5 tsp", "1/4 tsp"], ["  2 tsp", "  1 tsp"],
  ]) assert.equal(scaleAmount(input!, 4, 2), expected, input);
});

test("unknown and unsafe quantities remain literal; no global number replacement", () => {
  for (const value of ["", "to taste", "as needed", "a pinch", "about 2 cups", "2 x 400g", "2×400g", "1/0 cup", "1-2-3", "1 2 cups", "1.2.3 cups", "2%", "200°C"]) assert.equal(scaleAmount(value, 4, 2), value, value);
  assert.equal(scaleAmount("2 cups", null, 2), "2 cups");
  assert.equal(scaleAmount("½ cup", 2, 2), "½ cup");
  for (const target of [0, -1, Infinity, NaN]) assert.equal(scaleAmount("2 cups", 4, target), "2 cups");
});

test("scaling is reversible from source and supports small fractional quantities", () => {
  assert.equal(scaleAmount("1/8 tsp", 4, 2), "1/16 tsp");
  assert.equal(scaleAmount("2 eggs", 4, 3), "1 1/2 eggs");
  assert.equal(scaleAmount("2 eggs", 4, 4), "2 eggs");
  assert.equal(scaleAmount("1 g", 10000, 1), "0.0001 g");
});
