import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store, Worker } from "../src/server/store";
import { LocalPlan } from "../src/server/local-plan";
import { Persistence } from "../src/server/persistence";
import { handle, type App } from "../src/server/app";
import { formatHoursBefore, formatMinutes, parseRecipe, RecipeInputError, type Recipe } from "../src/recipe";
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
  return { id, projectId: "local-meals", name, date, time, requestId: id, state: "saved", error: "", confirmedAt: 0, slotId: slot?.id, ...extra };
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

test("prep reminders honour the [from, to) window and skip deleted, unmatched or undated cards", () => {
  const recipes = new Map<string, Recipe>([["a", dosa], ["c", { ...dosa, prep: [{ text: "Set curd", hoursBefore: 6 }] }]]);
  const cards = [
    card("k1", "தோசை", "2026-11-12", "08:00"),
    card("k2", "Dosa", "2026-11-12", "19:30", { deleting: true }),
    card("k3", "Pongal", "2026-11-12", "08:00"),
    card("k4", "Curd rice", "2026-11-11", "19:30"),
    card("k5", "Curd rice", "", "", { dueError: "No due date" }),
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

test("the recipe table is added in place to a database that predates it", () => {
  const path = join(root, `${randomUUID()}.sqlite`);
  const mealId = randomUUID();
  const old = new DatabaseSync(path);
  // The schema shipped with alternate names (PR #102), before recipes.
  old.exec(`CREATE TABLE "library" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "library_alias" ("mealId" CHARACTER NOT NULL REFERENCES "library" ("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "position" INTEGER NOT NULL, PRIMARY KEY ("mealId", "position"));
    CREATE TABLE "slot" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "time" TEXT NOT NULL);
    CREATE TABLE "local_meal" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL);
    CREATE TABLE "local_receipt" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL);
    CREATE TABLE "outbox" ("id" CHARACTER NOT NULL PRIMARY KEY, "payload" TEXT NOT NULL, "state" TEXT NOT NULL, "error" TEXT NOT NULL, "remoteId" TEXT NOT NULL, "attempted" TEXT NOT NULL, "nextAt" TEXT NOT NULL, "confirmedAt" TEXT NOT NULL);
    CREATE TABLE "setting" ("id" CHARACTER NOT NULL PRIMARY KEY, "value" TEXT NOT NULL);
    CREATE TABLE "session" ("id" CHARACTER NOT NULL PRIMARY KEY, "csrf" TEXT NOT NULL, "expiresAt" TEXT NOT NULL);
    PRAGMA user_version=1;`);
  old.prepare("INSERT INTO library VALUES (?, ?)").run(mealId, "இட்லி");
  old.prepare("INSERT INTO library_alias VALUES (?, ?, 0)").run(mealId, "Idli");
  old.prepare("INSERT INTO local_meal VALUES (?, ?)").run(randomUUID(), JSON.stringify({ name: "Idli" }));
  const tables = ["library", "library_alias", "local_meal"];
  const before = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all());
  old.close();

  const db = new Persistence(path);
  assert.equal(db.recipeAll().length, 0);
  db.recipePut({ mealId, body: JSON.stringify(dosa), updatedAt: "2026-11-10T00:00:00.000Z" });
  assert.throws(() => db.recipePut({ mealId: randomUUID(), body: "{}", updatedAt: "" }), /FOREIGN KEY/);
  db.close();
  // Reopening is a no-op; data, alias and version are untouched.
  new Persistence(path).close();
  const check = new DatabaseSync(path);
  assert.deepEqual(tables.map((table) => check.prepare(`SELECT * FROM ${table}`).all()), before);
  assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 1);
  assert.equal(check.prepare("SELECT count(*) AS n FROM recipe").get()!.n, 1);
  check.close();
});

async function fixture() {
  const path = join(root, `${randomUUID()}.sqlite`);
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed(false);
  const provider = new LocalPlan(store);
  const worker = new Worker(store, provider);
  const app: App = { store, todoist: provider, worker, origin: "http://localhost:3000", calendarToken: "secret-calendar-token-123456" };
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
    const board = await store.board(provider);
    await store.place({ requestId: randomUUID(), mealId, slotId: board.slots[slotIndex].id, date }, board.projectId);
    await worker.tick();
  };
  return { store, provider, worker, app, call, plan, close: async () => { await worker.stop(); await store.close(); } };
}

test("recipe API: save, read, board indicators, rename and removal", async () => {
  const f = await fixture();
  try {
    const meal = await f.store.addLibrary("தோசை");
    await f.store.renameLibrary(meal.id, "தோசை", ["Dosa"]);
    const other = await f.store.addLibrary("Pongal");
    await f.plan(meal.id, "2030-10-02");
    // A card planned under a different, alias name (e.g. imported from Todoist).
    const board0 = await f.store.board(f.provider);
    const breakfast = board0.slots.find((slot) => slot.time === "08:00")!;
    f.store.db.localMealInsert({ id: randomUUID(), body: JSON.stringify({ id: "x", projectId: "local-meals", name: "dosa", date: "2030-10-03", time: breakfast.time, requestId: randomUUID() }) });

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
    const renamed = await f.store.board(f.provider);
    assert.ok(renamed.cards.every((item) => item.libraryMealId === meal.id && item.hasRecipe));
    assert.equal((await f.call(`/api/recipes/${meal.id}`)).json.meal.name, "Ghee roast dosa");

    // Removing the meal removes its recipe; cards stay but lose the link.
    const removed = await f.call("/api/library/remove", "POST", { mealId: meal.id });
    assert.equal(removed.status, 202);
    assert.equal(f.store.db.recipeAll().length, 0);
    const after = await f.store.board(f.provider);
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

    assert.deepEqual((await f.call(`/api/recipes/${id}`, "DELETE")).json, { deleted: true });
    assert.deepEqual((await f.call(`/api/recipes/${id}`, "DELETE")).json, { deleted: false });
    assert.equal(f.store.db.libraryAll().length, 1, "deleting a recipe keeps the meal");
  } finally { await f.close(); }
});

test("prep API lists reminders for planned meals without the calendar link", async () => {
  const f = await fixture();
  try {
    const created = await f.call("/api/recipes", "POST", { name: "தோசை", recipe: dosa });
    const pongal = await f.store.addLibrary("Pongal");
    const board = await f.store.board(f.provider);
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
    // A meal being deleted no longer needs prep.
    const card = (await f.store.board(f.provider)).cards.find((item) => item.name === "தோசை")!;
    await f.store.change({ requestId: randomUUID(), taskId: card.id, kind: "delete" }, f.provider);
    assert.deepEqual((await f.call("/api/prep?from=2030-10-01T00:00&to=2030-10-02T00:00")).json.reminders, []);
    assert.equal((await f.call("/api/prep?from=yesterday")).status, 400);
    assert.equal((await f.call("/api/prep")).status, 200);
  } finally { await f.close(); }
});
