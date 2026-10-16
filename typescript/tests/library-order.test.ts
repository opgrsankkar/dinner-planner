import { test } from "node:test";
import assert from "node:assert/strict";
import { orderLibrary } from "../src/library-order";
import type { Meal } from "../src/types";

const meal = (id: string): Meal => ({ id, name: id });
const ids = (meals: Meal[]) => meals.map((item) => item.id);

test("newly created meal floats to the top without disturbing the rest", () => {
  const library = [meal("idli"), meal("dal"), meal("pasta")];
  assert.deepEqual(ids(orderLibrary(library, ["pasta"])), ["pasta", "idli", "dal"]);
  assert.deepEqual(ids(orderLibrary(library, ["dal"])), ["dal", "idli", "pasta"]);
});

test("the most recently added meal sorts first", () => {
  const library = [meal("idli"), meal("dal"), meal("pasta")];
  assert.deepEqual(ids(orderLibrary(library, ["pasta", "dal"])), [
    "pasta",
    "dal",
    "idli",
  ]);
});

test("unknown recent ids are ignored and the server order is preserved", () => {
  const library = [meal("idli"), meal("dal")];
  assert.deepEqual(ids(orderLibrary(library, ["missing"])), ["idli", "dal"]);
});

test("an empty recent list returns the same reference", () => {
  const library = [meal("idli")];
  assert.strictEqual(orderLibrary(library, []), library);
});

test("ordering does not mutate the input array", () => {
  const library = [meal("idli"), meal("dal")];
  orderLibrary(library, ["dal"]);
  assert.deepEqual(ids(library), ["idli", "dal"]);
});
