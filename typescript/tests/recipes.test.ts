import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/server/store";
import { Persistence, type RecipeRow } from "../src/server/persistence";
import { handle, type App } from "../src/server/app";
import { formatHoursBefore, formatMinutes, parseRecipe, RecipeInputError, type Recipe, type VariantSummary } from "../src/recipe";
import { kolkataIso, parseInstant, prepRange, prepReminders, resolveCardMeal } from "../src/server/recipes";
import type { Card, Meal, Slot } from "../src/types";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "planner-recipes-"));
  execFileSync(process.execPath, ["--import", "tsx", "scripts/init-db.ts"], {
    env: { ...process.env, DATABASE_PATH: join(root, "template.sqlite") }, stdio: "pipe",
  });
});
after(async () => { await rm(root, { recursive: true, force: true }); });

const dosa: Recipe = {
  servings: "4",
  totalMinutes: 40,
  notes: "",
  sourceUrl: "",
  ingredients: [{ amount: "3 cups", item: "இட்லி அரிசி (idli rice)" }, { amount: "1 cup", item: "urad dal" }],
  steps: [{ text: "Heat the tawa" }, { text: "Cook until crisp", timerMinutes: 3 }],
  prep: [{ text: "Soak rice and urad dal", hoursBefore: 20 }, { text: "Grind and ferment the batter", hoursBefore: 12 }],
};

test("parseRecipe normalises a valid recipe, keeps Tamil text and accepts string shortcuts", () => {
  const recipe = parseRecipe({
    servings: 4,
    totalMinutes: 30,
    notes: "  Use a cast-iron tawa  ",
    sourceUrl: "https://example.com/dosa",
    ingredients: ["  உப்பு  ", { amount: "to taste", item: "salt" }, { item: "oil" }],
    steps: ["Spread the batter", { text: "Flip", timerMinutes: 0.5 }],
    prep: [{ text: "ஊற வைக்கவும்", hoursBefore: 8 }],
    updatedAt: "ignored",
  });
  assert.deepEqual(recipe, {
    servings: "4",
    totalMinutes: 30,
    notes: "Use a cast-iron tawa",
    sourceUrl: "https://example.com/dosa",
    ingredients: [{ amount: "", item: "உப்பு" }, { amount: "to taste", item: "salt" }, { amount: "", item: "oil" }],
    steps: [{ text: "Spread the batter" }, { text: "Flip", timerMinutes: 0.5 }],
    prep: [{ text: "ஊற வைக்கவும்", hoursBefore: 8 }],
  });
  // NFC: a decomposed sequence is stored composed.
  assert.equal(parseRecipe({ notes: "é" }).notes, "é");
});

test("parseRecipe reports every problem with its field path", () => {
  const issues = (input: unknown) => {
    try { parseRecipe(input); } catch (error) {
      assert.ok(error instanceof RecipeInputError);
      return error.issues;
    }
    assert.fail("expected RecipeInputError");
  };
  assert.deepEqual(issues([]), ["body must be a JSON object"]);
  assert.deepEqual(issues({}), ["recipe is empty: add ingredients, steps, prep, notes or a sourceUrl (DELETE removes a recipe)"]);
  const found = issues({
    instructions: [],
    totalMinutes: 12.5,
    sourceUrl: "javascript:alert(1)",
    ingredients: [{ amount: "1", item: "" }, 4, { item: "x", qty: 1 }],
    steps: [{ text: "Stir", timerMinutes: -1 }, { timer: 3 }],
    prep: [{ text: "Soak" }, { text: "Thaw", hoursBefore: 200 }],
  });
  for (const expected of [
    'unknown field "instructions"',
    "totalMinutes must be a whole number",
    "sourceUrl must be an http(s) URL",
    "ingredients[0].item must not be empty",
    "ingredients[1] must be an object",
    'ingredients[2]: unknown field "qty"',
    "steps[0].timerMinutes must be a number greater than 0",
    'steps[1]: unknown field "timer"',
    "steps[1].text is required",
    "prep[0].hoursBefore must be a number",
    "prep[1].hoursBefore must be a number greater than 0 and at most 168",
  ])
    assert.ok(found.some((issue) => issue.includes(expected)), `missing "${expected}" in ${JSON.stringify(found)}`);
  assert.ok(issues({ steps: Array(61).fill("x") }).includes("steps may have at most 60 entries"));
});

test("durations read naturally", () => {
  assert.deepEqual([0.25, 2, 2.5, 60, 90, 1440].map(formatMinutes), ["15 s", "2 min", "2 min 30 s", "1 h", "1 h 30 min", "24 h"]);
  assert.deepEqual([0.5, 8, 12.5, 24, 48].map(formatHoursBefore), ["30 min before", "8 h before", "12.5 h before", "1 day before", "2 days before"]);
});

const library: Meal[] = [
  { id: "a", name: "தோசை", aliases: ["Dosa", "Plain dosa"] },
  { id: "b", name: "Masala dosa", aliases: [] },
  { id: "c", name: "Curd rice", aliases: ["Thayir sadam"] },
];

test("a card resolves to its recorded library meal, then by name, then by alternate name", () => {
  assert.equal(resolveCardMeal({ name: "தோசை" }, library)?.id, "a");
  assert.equal(resolveCardMeal({ name: "  masala   DOSA " }, library)?.id, "b");
  assert.equal(resolveCardMeal({ name: "dosa" }, library)?.id, "a");
  assert.equal(resolveCardMeal({ name: "thayir  sadam" }, library)?.id, "c");
  assert.equal(resolveCardMeal({ name: "Pongal" }, library), undefined);
  // A recorded meal wins over the name, so renaming the meal keeps the link…
  assert.equal(resolveCardMeal({ name: "Old name", mealId: "c" }, library)?.id, "c");
  // …and a recorded meal that was removed falls back to the name.
  assert.equal(resolveCardMeal({ name: "Dosa", mealId: "gone" }, library)?.id, "a");
  assert.equal(resolveCardMeal({ name: "Dosa", mealId: "" }, library)?.id, "a");
});

const slots: Slot[] = [
  { id: "s-breakfast", name: "Breakfast", time: "08:00" },
  { id: "s-dinner", name: "Dinner", time: "19:30" },
];
function card(id: string, name: string, date: string, time: string, extra: Partial<Card> = {}): Card {
  const slot = slots.find((entry) => entry.time === time);
  return { id, name, date, time, slotId: slot?.id, ...extra };
}
const at = (value: string) => Date.parse(value);

test("prep reminders fall back across midnight onto the previous day in Asia/Kolkata", () => {
  const recipes = new Map<string, Recipe>([["a", dosa]]);
  const cards = [card("k1", "Dosa", "2026-11-12", "08:00")];
  const reminders = prepReminders(cards, slots, library, recipes, at("2026-11-10T00:00:00+05:30"), at("2026-11-13T00:00:00+05:30"));
  assert.deepEqual(reminders.map((item) => [item.dueAt, item.dueDate, item.dueTime, item.text]), [
    ["2026-11-11T12:00:00+05:30", "2026-11-11", "12:00", "Soak rice and urad dal"],
    ["2026-11-11T20:00:00+05:30", "2026-11-11", "20:00", "Grind and ferment the batter"],
  ]);
  assert.deepEqual({ ...reminders[1], text: undefined }, {
    dueAt: "2026-11-11T20:00:00+05:30", dueDate: "2026-11-11", dueTime: "20:00", text: undefined,
    hoursBefore: 12, mealName: "Dosa", libraryMealId: "a", cardId: "k1", date: "2026-11-12",
    slotId: "s-breakfast", slotName: "Breakfast", slotTime: "08:00", mealAt: "2026-11-12T08:00:00+05:30",
    overdue: false,
  });
  // A 8.5 h prep before a 08:00 meal is due at 23:30 the evening before; the
  // timezone (not the host clock) decides the date.
  const late = new Map<string, Recipe>([["a", { ...dosa, prep: [{ text: "Thaw", hoursBefore: 8.5 }] }]]);
  assert.equal(prepReminders(cards, slots, library, late, 0, Infinity)[0].dueAt, "2026-11-11T23:30:00+05:30");
  assert.equal(new Date(at("2026-11-11T23:30:00+05:30")).toISOString(), "2026-11-11T18:00:00.000Z");
});

test("prep reminders honour the [from, to) window and skip unmatched or undated cards", () => {
  const recipes = new Map<string, Recipe>([["a", dosa], ["c", { ...dosa, prep: [{ text: "Set curd", hoursBefore: 6 }] }]]);
  const cards = [
    card("k1", "தோசை", "2026-11-12", "08:00"),
    card("k3", "Pongal", "2026-11-12", "08:00"),
    card("k4", "Curd rice", "2026-11-11", "19:30"),
    card("k5", "Curd rice", "", ""),
    card("k6", "Masala dosa", "2026-11-11", "19:30"),
  ];
  const from = at("2026-11-11T12:00:00+05:30");
  const to = at("2026-11-11T20:00:00+05:30");
  // 12:00 (k1 soak) is inside, 20:00 (k1 ferment) is the exclusive end, k4's curd at 13:30.
  assert.deepEqual(prepReminders(cards, slots, library, recipes, from, to).map((item) => [item.cardId, item.dueTime]), [
    ["k1", "12:00"],
    ["k4", "13:30"],
  ]);
});

test("overdue prep is included on request while its meal is still ahead", () => {
  const recipes = new Map<string, Recipe>([["a", dosa]]);
  const cards = [card("k1", "Dosa", "2026-11-12", "08:00"), card("k2", "Dosa", "2026-11-11", "08:00")];
  // 22:35 the evening before k2: its 20:00 ferment was missed; k1's soak (12:00 on the 11th) is ahead.
  const now = at("2026-11-10T22:35:00+05:30");
  const to = at("2026-11-12T00:00:00+05:30");
  assert.deepEqual(prepReminders(cards, slots, library, recipes, now, to).map((item) => [item.cardId, item.dueAt]), [
    ["k1", "2026-11-11T12:00:00+05:30"],
    ["k1", "2026-11-11T20:00:00+05:30"],
  ]);
  assert.deepEqual(prepReminders(cards, slots, library, recipes, now, to, true).map((item) => [item.cardId, item.dueAt, item.overdue]), [
    ["k2", "2026-11-10T12:00:00+05:30", true],
    ["k2", "2026-11-10T20:00:00+05:30", true],
    ["k1", "2026-11-11T12:00:00+05:30", false],
    ["k1", "2026-11-11T20:00:00+05:30", false],
  ]);
  // Once the meal has started nothing is overdue any more.
  assert.equal(prepReminders(cards, slots, library, recipes, at("2026-11-11T08:00:00+05:30"), to, true).filter((item) => item.cardId === "k2").length, 0);
});

test("prep range defaults to now until the end of tomorrow and validates bounds", () => {
  const now = at("2026-11-10T15:10:00+05:30");
  assert.deepEqual(prepRange(now), { from: now, to: at("2026-11-12T00:00:00+05:30") });
  // 23:00 IST is 17:30Z the same day; "tomorrow" is still by the Kolkata date.
  const lateNow = at("2026-11-10T23:00:00+05:30");
  assert.equal(kolkataIso(prepRange(lateNow).to), "2026-11-12T00:00:00+05:30");
  assert.equal(parseInstant("2026-11-10T18:00", "from"), at("2026-11-10T18:00:00+05:30"));
  assert.equal(parseInstant("2026-11-10T12:30:00Z", "from"), at("2026-11-10T18:00:00+05:30"));
  assert.throws(() => parseInstant("2026-11-10", "from"), /Invalid from/);
  assert.throws(() => parseInstant("tomorrow", "to"), /Invalid to/);
  assert.throws(() => prepRange(now, "2026-11-10T18:00", "2026-11-10T17:00"), /after/);
  assert.throws(() => prepRange(now, "2026-11-01T00:00", "2026-11-20T00:00"), /at most 14 days/);
});

// The schema shipped with alternate names (PR #102), before recipes.
const preRecipesSchema = `CREATE TABLE "library" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "library_alias" ("mealId" CHARACTER NOT NULL REFERENCES "library" ("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "position" INTEGER NOT NULL, PRIMARY KEY ("mealId", "position"));
    CREATE TABLE "slot" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "time" TEXT NOT NULL);
    CREATE TABLE "local_meal" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL);
    CREATE TABLE "local_receipt" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL);
    CREATE TABLE "outbox" ("id" CHARACTER NOT NULL PRIMARY KEY, "payload" TEXT NOT NULL, "state" TEXT NOT NULL, "error" TEXT NOT NULL, "remoteId" TEXT NOT NULL, "attempted" TEXT NOT NULL, "nextAt" TEXT NOT NULL, "confirmedAt" TEXT NOT NULL);
    CREATE TABLE "setting" ("id" CHARACTER NOT NULL PRIMARY KEY, "value" TEXT NOT NULL);
    CREATE TABLE "session" ("id" CHARACTER NOT NULL PRIMARY KEY, "csrf" TEXT NOT NULL, "expiresAt" TEXT NOT NULL);
    PRAGMA user_version=1;`;
// …and the one-recipe-per-meal table that recipes shipped with (PR #103).
const recipesV1Table = `CREATE TABLE "recipe" ("mealId" CHARACTER NOT NULL PRIMARY KEY REFERENCES "library" ("id") ON DELETE CASCADE, "body" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);`;
const variantRow = (mealId: string, body: Recipe, extra: Partial<RecipeRow> = {}): RecipeRow =>
  ({ id: randomUUID(), mealId, label: "", isDefault: true, position: 0, body: JSON.stringify(body), updatedAt: "2026-11-10T00:00:00.000Z", ...extra });

test("the recipe table is added to a database that predates recipes", () => {
  const path = join(root, `${randomUUID()}.sqlite`);
  const mealId = randomUUID();
  const old = new DatabaseSync(path);
  old.exec(preRecipesSchema);
  old.prepare("INSERT INTO library VALUES (?, ?)").run(mealId, "இட்லி");
  old.prepare("INSERT INTO library_alias VALUES (?, ?, 0)").run(mealId, "Idli");
  const planned = randomUUID();
  old.prepare("INSERT INTO local_meal VALUES (?, ?)").run(planned, JSON.stringify({ name: "Idli" }));
  const tables = ["library", "library_alias"];
  const before = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all());
  old.close();

  const db = new Persistence(path);
  assert.equal(db.recipeCounts().size, 0);
  db.recipeInsert(variantRow(mealId, dosa));
  assert.throws(() => db.recipeInsert(variantRow(randomUUID(), dosa)), /FOREIGN KEY/);
  db.close();
  // Reopening is a no-op; data and alias are untouched.
  new Persistence(path).close();
  const check = new DatabaseSync(path);
  assert.deepEqual(tables.map((table) => check.prepare(`SELECT * FROM ${table}`).all()), before);
  assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 3);
  assert.equal(check.prepare("SELECT count(*) AS n FROM recipe").get()!.n, 1);
  // Its planned meal moved into planned_meal (schema v3) with the same id.
  assert.equal(check.prepare("SELECT name FROM planned_meal WHERE id = ?").get(planned)!.name, "Idli");
  check.close();
});

test("the one-recipe-per-meal table becomes default variants in place, once", () => {
  const path = join(root, `${randomUUID()}.sqlite`);
  const [idli, dosaId, bare] = [randomUUID(), randomUUID(), randomUUID()];
  const old = new DatabaseSync(path);
  old.exec(preRecipesSchema + recipesV1Table);
  for (const [id, name] of [[idli, "இட்லி"], [dosaId, "தோசை"], [bare, "Upma"]]) old.prepare("INSERT INTO library VALUES (?, ?)").run(id, name);
  old.prepare("INSERT INTO recipe VALUES (?, ?, ?)").run(idli, JSON.stringify({ ...dosa, notes: "இட்லி notes" }), "2026-11-09T01:02:03.004Z");
  old.prepare("INSERT INTO recipe VALUES (?, ?, ?)").run(dosaId, JSON.stringify(dosa), "2026-11-10T05:06:07.008Z");
  const before = old.prepare("SELECT * FROM library").all();
  old.close();

  const db = new Persistence(path);
  const migrated = [idli, dosaId].map((id) => db.recipeVariants(id));
  assert.deepEqual(migrated.map((rows) => rows.map(({ id: _id, ...row }) => row)), [
    [{ mealId: idli, label: "", isDefault: true, position: 0, body: JSON.stringify({ ...dosa, notes: "இட்லி notes" }), updatedAt: "2026-11-09T01:02:03.004Z" }],
    [{ mealId: dosaId, label: "", isDefault: true, position: 0, body: JSON.stringify(dosa), updatedAt: "2026-11-10T05:06:07.008Z" }],
  ]);
  assert.deepEqual([...db.recipeCounts()].sort(), [[dosaId, 1], [idli, 1]].sort());
  assert.deepEqual(db.recipeVariants(bare), []);
  // One default per meal is enforced by the database.
  assert.throws(() => db.recipeInsert(variantRow(idli, dosa, { label: "Second", position: 1 })), /UNIQUE/);
  db.recipeInsert(variantRow(idli, dosa, { label: "Second", isDefault: false, position: 1 }));
  db.close();

  // Running the migration again changes nothing (variant ids are kept).
  const again = new Persistence(path);
  assert.deepEqual(again.recipeVariants(dosaId), migrated[1]);
  assert.equal(again.recipeVariants(idli).length, 2);
  again.close();
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 3);
  assert.deepEqual(check.prepare("SELECT * FROM library").all(), before);
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'recipe_v1'").get()!.n, 0);
  // Removing a meal still removes all of its variants.
  check.exec("PRAGMA foreign_keys=ON");
  check.prepare("DELETE FROM library WHERE id = ?").run(idli);
  assert.equal(check.prepare("SELECT count(*) AS n FROM recipe WHERE mealId = ?").get(idli)!.n, 0);
  check.close();
});

async function fixture() {
  const path = join(root, `${randomUUID()}.sqlite`);
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed(false);
  const app: App = { store, origin: "http://localhost:3000", calendarToken: "secret-calendar-token-123456" };
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await handle(new Request(app.origin + path, {
      method,
      headers: { ...(method === "GET" ? {} : { origin: app.origin }), "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), app);
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  const plan = async (mealId: string, date: string, slotIndex = 0) => {
    const board = await store.board();
    await store.place({ requestId: randomUUID(), mealId, slotId: board.slots[slotIndex].id, date });
  };
  return { store, app, call, plan, close: async () => { await store.close(); } };
}

test("recipe API: save, read, board indicators, rename and removal", async () => {
  const f = await fixture();
  try {
    const meal = await f.store.addLibrary("தோசை");
    await f.store.renameLibrary(meal.id, "தோசை", ["Dosa"]);
    const other = await f.store.addLibrary("Pongal");
    await f.plan(meal.id, "2030-10-02");
    // A card planned under a different, alias name (e.g. imported from Todoist).
    const board0 = await f.store.board();
    const breakfast = board0.slots.find((slot) => slot.time === "08:00")!;
    f.store.db.plannedInsert({ id: randomUUID(), mealId: null, name: "dosa", date: "2030-10-03", time: breakfast.time });

    assert.equal((await f.call(`/api/recipes/${meal.id}`)).status, 404);
    const saved = await f.call(`/api/recipes/${meal.id}`, "PUT", dosa);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.meal.name, "தோசை");
    assert.deepEqual({ ...saved.json.recipe, updatedAt: undefined }, { ...dosa, updatedAt: undefined });

    const read = await f.call(`/api/recipes/${meal.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.recipe, saved.json.recipe);
    assert.ok(!read.text.includes("secret-calendar-token"));

    const board = await f.call("/api/board");
    assert.ok(board.text.includes("secret-calendar-token"), "board still carries the calendar link");
    const cards = board.json.cards as Card[];
    assert.equal(cards.length, 2);
    for (const item of cards) assert.deepEqual([item.libraryMealId, item.hasRecipe], [meal.id, true]);
    assert.deepEqual((board.json.library as Meal[]).map((entry) => [entry.name, entry.hasRecipe]).sort(), [["Pongal", false], ["தோசை", true]]);

    const index = await f.call("/api/recipes");
    assert.deepEqual((index.json.meals as Meal[]).map((entry) => [entry.name, entry.hasRecipe]), [["Pongal", false], ["தோசை", true]]);
    assert.deepEqual((await f.call(`/api/recipes?name=${encodeURIComponent("DOSA")}`)).json.meals.map((entry: Meal) => entry.id), [meal.id]);
    assert.deepEqual((await f.call("/api/recipes?name=Upma")).json.meals, []);

    // Renaming keeps the recipe. The card planned from the library keeps its
    // meal by id; the alias-named card still matches the kept alias.
    await f.store.renameLibrary(meal.id, "Ghee roast dosa", ["Dosa"]);
    const renamed = await f.store.board();
    assert.ok(renamed.cards.every((item) => item.libraryMealId === meal.id && item.hasRecipe));
    assert.equal((await f.call(`/api/recipes/${meal.id}`)).json.meal.name, "Ghee roast dosa");

    // Removing the meal removes its recipe; cards stay but lose the link.
    const removed = await f.call("/api/library/remove", "POST", { mealId: meal.id });
    assert.equal(removed.status, 202);
    assert.equal(f.store.db.recipeCounts().size, 0);
    const after = await f.store.board();
    assert.equal(after.cards.length, 2);
    assert.ok(after.cards.every((item) => item.libraryMealId === null && item.hasRecipe === false));
    assert.equal((await f.call(`/api/recipes/${meal.id}`)).json.error, "Meal not found");
    assert.equal((await f.call(`/api/recipes/${other.id}`)).json.error, "This meal has no recipe");
  } finally { await f.close(); }
});

test("recipe API: create by name, conflicts, deletes and validation errors", async () => {
  const f = await fixture();
  try {
    const created = await f.call("/api/recipes", "POST", { name: "  வெண் பொங்கல் ", recipe: { ingredients: ["rice", "moong dal"], steps: ["Pressure cook"] } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.created, true);
    assert.equal(created.json.meal.name, "வெண் பொங்கல்");
    const id = created.json.meal.id as string;
    await f.store.renameLibrary(id, "வெண் பொங்கல்", ["Ven pongal"]);

    // The alias finds the same meal; an existing recipe needs replace: true.
    const conflict = await f.call("/api/recipes", "POST", { name: "ven Pongal", recipe: { notes: "x" } });
    assert.equal(conflict.status, 409);
    assert.match(conflict.json.error, /already has a recipe/);
    const replaced = await f.call("/api/recipes", "POST", { name: "ven Pongal", replace: true, recipe: { notes: "Add pepper" } });
    assert.equal(replaced.status, 200);
    assert.deepEqual([replaced.json.created, replaced.json.meal.id, replaced.json.recipe.notes, replaced.json.recipe.steps], [false, id, "Add pepper", []]);
    assert.equal(f.store.db.libraryAll().length, 1);

    const invalid = await f.call(`/api/recipes/${id}`, "PUT", { steps: [{ txt: "x" }] });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error, /^Invalid recipe: /);
    assert.deepEqual(invalid.json.issues, ['steps[0]: unknown field "txt" (allowed: text, timerMinutes)', "steps[0].text is required"]);
    assert.equal((await f.call("/api/recipes", "POST", { recipe: { notes: "x" } })).json.error, "name is required");
    assert.equal((await f.call("/api/recipes", "POST", { name: "x", replace: "yes", recipe: { notes: "x" } })).status, 400);
    assert.equal((await f.call(`/api/recipes/${id}`, "PUT", "not json")).json.error, "Request body must be JSON");
    assert.equal((await f.call(`/api/recipes/${id}`, "PUT", { notes: "x".repeat(300_000) })).status, 413);
    assert.equal((await f.call("/api/recipes/not-a-uuid")).status, 400);
    assert.equal((await f.call(`/api/recipes/${randomUUID()}`, "PUT", { notes: "x" })).status, 404);

    // Writes need the planner's own Origin, as every other write does.
    for (const [method, path, body] of [["PUT", `/api/recipes/${id}`, { notes: "x" }], ["DELETE", `/api/recipes/${id}`, undefined], ["POST", "/api/recipes", { name: "x", recipe: { notes: "x" } }]] as const) {
      assert.equal((await f.call(path, method, body, { origin: "http://evil.test" })).status, 403);
      const request = new Request(f.app.origin + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
      assert.equal((await handle(request, f.app)).status, 403);
    }
    assert.equal((await handle(new Request("http://evil.test/api/recipes"), f.app)).status, 403);

    // Old callers read `deleted`; the remaining variants are added alongside.
    assert.deepEqual((await f.call(`/api/recipes/${id}`, "DELETE")).json, { deleted: true, variants: [] });
    assert.deepEqual((await f.call(`/api/recipes/${id}`, "DELETE")).json, { deleted: false, variants: [] });
    assert.equal(f.store.db.libraryAll().length, 1, "deleting a recipe keeps the meal");
  } finally { await f.close(); }
});

test("prep API lists reminders for planned meals without the calendar link", async () => {
  const f = await fixture();
  try {
    const created = await f.call("/api/recipes", "POST", { name: "தோசை", recipe: dosa });
    const pongal = await f.store.addLibrary("Pongal");
    const board = await f.store.board();
    const breakfast = board.slots.findIndex((slot) => slot.time === "08:00");
    await f.plan(created.json.meal.id, "2030-10-02", breakfast);
    await f.plan(pongal.id, "2030-10-02", breakfast);
    const result = await f.call(`/api/prep?from=${encodeURIComponent("2030-10-01T00:00")}&to=${encodeURIComponent("2030-10-02T00:00+05:30")}`);
    assert.equal(result.status, 200, result.text);
    assert.ok(!result.text.includes("secret-calendar-token"));
    assert.deepEqual([result.json.from, result.json.to], ["2030-10-01T00:00:00+05:30", "2030-10-02T00:00:00+05:30"]);
    assert.deepEqual(result.json.reminders.map((item: { dueAt: string; text: string; mealName: string; slotName: string }) => [item.dueAt, item.text, item.mealName, item.slotName]), [
      ["2030-10-01T12:00:00+05:30", "Soak rice and urad dal", "தோசை", "Breakfast"],
      ["2030-10-01T20:00:00+05:30", "Grind and ferment the batter", "தோசை", "Breakfast"],
    ]);
    // A deleted meal no longer needs prep.
    const card = (await f.store.board()).cards.find((item) => item.name === "தோசை")!;
    await f.store.change({ taskId: card.id, kind: "delete" });
    assert.deepEqual((await f.call("/api/prep?from=2030-10-01T00:00&to=2030-10-02T00:00")).json.reminders, []);
    assert.equal((await f.call("/api/prep?from=yesterday")).status, 400);
    assert.equal((await f.call("/api/prep")).status, 200);
  } finally { await f.close(); }
});

const fry: Recipe = {
  ...dosa,
  notes: "Roast the masala first.",
  ingredients: [...dosa.ingredients, { amount: "2", item: "red chillies" }],
  steps: [{ text: "Roast the masala", timerMinutes: 4 }, ...dosa.steps],
  prep: [],
};

test("recipe variants: add, read, labels, default, rename and delete", async () => {
  const f = await fixture();
  try {
    const meal = await f.store.addLibrary("Tomato Sambar");
    const single = await f.call(`/api/recipes/${meal.id}`, "PUT", dosa);
    assert.equal(single.status, 200, single.text);
    // A single recipe reads exactly as before, plus its one unlabeled variant.
    const first = single.json.variant;
    assert.deepEqual([first.label, first.isDefault], ["", true]);
    assert.deepEqual(single.json.variants, [first]);
    assert.deepEqual([single.json.meal.hasRecipe, single.json.meal.variantCount], [true, 1]);
    assert.deepEqual({ ...single.json.recipe, updatedAt: undefined }, { ...dosa, updatedAt: undefined });

    // A second variant labels the first one too.
    const missing = await f.call(`/api/recipes/${meal.id}/variants`, "POST", { recipe: fry });
    assert.deepEqual([missing.status, missing.json.error], [400, "label is required"]);
    const added = await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label: "  Fry ", existingLabel: "Non-fry", recipe: fry });
    assert.equal(added.status, 201, added.text);
    const fryId = added.json.variant.id as string;
    assert.deepEqual(added.json.variants.map((v: VariantSummary) => [v.label, v.isDefault]), [["Non-fry", true], ["Fry", false]]);
    assert.deepEqual(added.json.recipe.steps, fry.steps);

    // The plain GET still returns the default recipe in the old shape.
    const read = await f.call(`/api/recipes/${meal.id}`);
    assert.deepEqual(Object.keys(read.json).sort(), ["meal", "recipe", "variant", "variants"]);
    assert.deepEqual(read.json.recipe.steps, dosa.steps);
    assert.deepEqual([read.json.variant.id, read.json.variant.label, read.json.meal.variantCount], [first.id, "Non-fry", 2]);
    assert.ok(read.json.variants.every((v: object) => !("recipe" in v)));
    // ?variant= and /variants/<id> read another; ?all=1 carries every recipe.
    assert.deepEqual((await f.call(`/api/recipes/${meal.id}?variant=${fryId}`)).json.recipe.steps, fry.steps);
    assert.deepEqual((await f.call(`/api/recipes/${meal.id}/variants/${fryId}`)).json.variant.label, "Fry");
    const all = await f.call(`/api/recipes/${meal.id}?all=1`);
    assert.deepEqual(all.json.variants.map((v: { recipe: Recipe }) => v.recipe.steps.length), [2, 3]);
    assert.equal((await f.call(`/api/recipes/${meal.id}?variant=${randomUUID()}`)).status, 404);
    assert.equal((await f.call(`/api/recipes/${meal.id}?variant=nope`)).json.error, "Invalid variant ID");

    // Labels are unique within a meal, ignoring case and spacing.
    for (const label of ["fry", "FRY", " non-FRY "]) {
      const taken = await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label, recipe: fry });
      assert.equal(taken.status, 409, label);
      assert.match(taken.json.error, /already has a variant called/);
    }
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants/${fryId}`, "PATCH", { label: "non-fry" })).status, 409);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants/${fryId}`, "PATCH", { label: "" })).status, 400);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label: "x".repeat(41), recipe: fry })).status, 400);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label: "x", recipe: fry, colour: "red" })).status, 400);
    // Same label on a different meal is fine; a Tamil label works.
    const other = await f.store.addLibrary("Rasam");
    await f.call(`/api/recipes/${other.id}`, "PUT", dosa);
    assert.equal((await f.call(`/api/recipes/${other.id}/variants`, "POST", { label: "Fry", recipe: fry })).status, 201);
    const tamil = await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label: "வறுத்தது", copyFrom: fryId });
    assert.equal(tamil.status, 201, tamil.text);
    assert.deepEqual(tamil.json.recipe.steps, fry.steps, "copyFrom copies the whole recipe");
    const tamilId = tamil.json.variant.id as string;

    // Rename and make default; the old one stops being default.
    const renamed = await f.call(`/api/recipes/${meal.id}/variants/${fryId}`, "PATCH", { label: "Fried masala", isDefault: true });
    assert.equal(renamed.status, 200, renamed.text);
    assert.deepEqual(renamed.json.variants.map((v: VariantSummary) => [v.label, v.isDefault]), [["Non-fry", false], ["Fried masala", true], ["வறுத்தது", false]]);
    assert.deepEqual((await f.call(`/api/recipes/${meal.id}`)).json.recipe.steps, fry.steps);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants/${fryId}`, "PATCH", { isDefault: false })).status, 400);

    // Old-style PUT replaces the default variant only, keeping its id and label.
    const put = await f.call(`/api/recipes/${meal.id}`, "PUT", { ...fry, notes: "Edited" });
    assert.deepEqual([put.json.variant.id, put.json.variant.label, put.json.recipe.notes], [fryId, "Fried masala", "Edited"]);
    assert.equal((await f.call(`/api/recipes/${meal.id}?variant=${first.id}`)).json.recipe.notes, "");
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants/${tamilId}`, "PUT", { notes: "Only notes" })).json.recipe.notes, "Only notes");

    // At most four variants.
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label: "Four", copyFrom: fryId })).status, 201);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label: "Five", copyFrom: fryId })).status, 409);

    // Board cards and library entries carry the count.
    await f.plan(meal.id, "2030-10-02");
    const board = await f.store.board();
    assert.deepEqual(board.cards.map((card) => [card.hasRecipe, card.variantCount]), [[true, 4]]);
    assert.deepEqual(board.library.find((entry) => entry.id === meal.id)?.variantCount, 4);
    assert.deepEqual((await f.call("/api/recipes?name=tomato sambar")).json.meals[0].variantCount, 4);

    // Deleting the default promotes the first remaining variant.
    const deleted = await f.call(`/api/recipes/${meal.id}/variants/${fryId}`, "DELETE");
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json.variants.map((v: VariantSummary) => [v.label, v.isDefault]), [["Non-fry", true], ["வறுத்தது", false], ["Four", false]]);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants/${fryId}`, "DELETE")).json.deleted, false, "repeating is safe");
    // Old-style DELETE removes the default variant only.
    const oldDelete = await f.call(`/api/recipes/${meal.id}`, "DELETE");
    assert.deepEqual(oldDelete.json.variants.map((v: VariantSummary) => [v.label, v.isDefault]), [["வறுத்தது", true], ["Four", false]]);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants/${tamilId}`, "DELETE")).json.variants.length, 1);
    // A lone variant may drop its label again; deleting the last leaves no recipe.
    const lone = (await f.call(`/api/recipes/${meal.id}`)).json.variant;
    assert.deepEqual([lone.label, lone.isDefault], ["Four", true]);
    assert.equal((await f.call(`/api/recipes/${meal.id}/variants/${lone.id}`, "PATCH", { label: "" })).json.variant.label, "");
    assert.deepEqual((await f.call(`/api/recipes/${meal.id}/variants/${lone.id}`, "DELETE")).json, { deleted: true, variants: [] });
    assert.equal((await f.call(`/api/recipes/${meal.id}`)).json.error, "This meal has no recipe");
    assert.equal((await f.store.board()).cards[0]!.hasRecipe, false);
    assert.equal(f.store.db.libraryAll().length, 2, "deleting variants keeps the meal");

    // ?all=1 on DELETE removes every variant.
    assert.deepEqual((await f.call(`/api/recipes/${other.id}?all=1`, "DELETE")).json, { deleted: true, variants: [] });

    // Writes need the planner's own Origin.
    for (const [method, path] of [["POST", `/api/recipes/${meal.id}/variants`], ["PATCH", `/api/recipes/${meal.id}/variants/${fryId}`], ["DELETE", `/api/recipes/${meal.id}/variants/${fryId}`]] as const)
      assert.equal((await f.call(path, method, { label: "x", recipe: fry }, { origin: "http://evil.test" })).status, 403);
  } finally { await f.close(); }
});

test("POST /api/recipes adds or replaces a variant by label", async () => {
  const f = await fixture();
  try {
    const created = await f.call("/api/recipes", "POST", { name: "Tomato Sambar", recipe: dosa });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json.variants.map((v: VariantSummary) => v.label), [""]);
    // "Add a Fry variant of Tomato Sambar"; the first one is labelled "Original" if not named.
    const added = await f.call("/api/recipes", "POST", { name: "tomato  sambar", variant: "Fry", recipe: fry });
    assert.equal(added.status, 200, added.text);
    assert.deepEqual([added.json.created, added.json.variant.label], [false, "Fry"]);
    assert.deepEqual(added.json.variants.map((v: VariantSummary) => [v.label, v.isDefault]), [["Original", true], ["Fry", false]]);
    // The same label again needs replace; replace keeps the variant id.
    assert.equal((await f.call("/api/recipes", "POST", { name: "Tomato Sambar", variant: "fry", recipe: fry })).status, 409);
    const replaced = await f.call("/api/recipes", "POST", { name: "Tomato Sambar", variant: "fry", replace: true, recipe: { notes: "New" } });
    assert.deepEqual([replaced.json.variant.id, replaced.json.recipe.notes], [added.json.variant.id, "New"]);
    // Without a variant label it is the default recipe, as before.
    assert.equal((await f.call("/api/recipes", "POST", { name: "Tomato Sambar", recipe: dosa })).status, 409);
    const def = await f.call("/api/recipes", "POST", { name: "Tomato Sambar", replace: true, recipe: { notes: "Default" } });
    assert.deepEqual([def.json.variant.label, def.json.recipe.notes], ["Original", "Default"]);
    // A new meal can start with a labelled variant, and existingLabel names the first.
    const pongal = await f.call("/api/recipes", "POST", { name: "Pongal", recipe: dosa });
    const second = await f.call("/api/recipes", "POST", { name: "Pongal", variant: "Sweet", existingLabel: "Ven", recipe: fry });
    assert.deepEqual(second.json.variants.map((v: VariantSummary) => v.label), ["Ven", "Sweet"]);
    assert.equal(f.store.db.libraryAll().length, 2, pongal.text);
    assert.equal((await f.call("/api/recipes", "POST", { name: "Pongal", variant: "", recipe: fry })).status, 409, "empty label means the default");
  } finally { await f.close(); }
});

test("prep reminders come from the default variant only", async () => {
  const f = await fixture();
  try {
    const meal = await f.store.addLibrary("தோசை");
    const plain = (await f.call(`/api/recipes/${meal.id}`, "PUT", { ...dosa, prep: [] })).json.variant.id as string;
    const soaked = await f.call(`/api/recipes/${meal.id}/variants`, "POST", { label: "Soaked", existingLabel: "Instant", recipe: dosa });
    const board = await f.store.board();
    await f.plan(meal.id, "2030-10-02", board.slots.findIndex((slot) => slot.time === "08:00"));
    const window = `/api/prep?from=${encodeURIComponent("2030-10-01T00:00")}&to=${encodeURIComponent("2030-10-02T00:00")}`;
    assert.deepEqual((await f.call(window)).json.reminders, [], "the non-default variant's prep is not reminded");
    await f.call(`/api/recipes/${meal.id}/variants/${soaked.json.variant.id}`, "PATCH", { isDefault: true });
    assert.deepEqual((await f.call(window)).json.reminders.map((item: { text: string }) => item.text), ["Soak rice and urad dal", "Grind and ferment the batter"]);
    await f.call(`/api/recipes/${meal.id}/variants/${plain}`, "PATCH", { isDefault: true });
    assert.deepEqual((await f.call(window)).json.reminders, []);
  } finally { await f.close(); }
});
