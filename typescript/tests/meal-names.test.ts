import { test } from "node:test";
import assert from "node:assert/strict";
import { findMealByName, parseAliases, searchMeal } from "../src/meal-names";

const curd = { id: "1", name: "Curd rice", aliases: ["Thayir sadam", "Mosaru anna"] };
const dosa = { id: "2", name: "Dosa", aliases: [] };
const masala = { id: "3", name: "Masala dosa", aliases: ["Dosa masala"] };

test("search matches the name first, then reports the alternate name it matched", () => {
  assert.deepEqual(searchMeal(curd, ""), { match: true });
  assert.deepEqual(searchMeal(curd, "  CURD "), { match: true });
  assert.deepEqual(searchMeal(curd, "thayir"), { match: true, alias: "Thayir sadam" });
  assert.deepEqual(searchMeal(curd, "mosaru  anna"), { match: true, alias: "Mosaru anna" });
  assert.deepEqual(searchMeal(curd, "dosa"), { match: false });
});

test("a typed name finds its meal by exact name before alias", () => {
  const meals = [masala, curd, dosa];
  assert.equal(findMealByName(meals, " thayir   SADAM "), curd);
  assert.equal(findMealByName(meals, "dosa"), dosa);
  assert.equal(findMealByName(meals, "dosa masala"), masala);
  assert.equal(findMealByName(meals, "thayir"), undefined);
});

test("alternate names are typed comma-separated", () => {
  assert.deepEqual(parseAliases(" Thayir sadam, ,Mosaru anna ,"), ["Thayir sadam", "Mosaru anna"]);
  assert.deepEqual(parseAliases("   "), []);
});
