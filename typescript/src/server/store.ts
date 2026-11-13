import { sortSlotsByTime } from "../slot-order";
import { isPastSlot } from "../past-slot";
import { Persistence } from "./persistence";
import { findMealByName, maxMealAliases, maxMealNameLength, mealNameKey } from "../meal-names";
import { randomUUID } from "node:crypto";
import type { Board, Card, Meal, Settings, Slot } from "../types";
import { addDays } from "../week-calendar";
import {
  cleanVariantLabel, fallbackVariantLabel, maxVariantLabelLength, maxVariants, parseRecipe, variantLabelKey,
  type Recipe, type StoredRecipe, type VariantSummary,
} from "../recipe";
import { prepReminders, RequestError, resolveCardMeal } from "./recipes";
import type { Persistence as Db, RecipeRow } from "./persistence";
function storedRecipe(row: RecipeRow): StoredRecipe {
  return { ...(JSON.parse(row.body) as Recipe), updatedAt: row.updatedAt };
}
function variantSummary(row: RecipeRow): VariantSummary {
  return { id: row.id, label: row.label, isDefault: row.isDefault, updatedAt: row.updatedAt };
}
// What every recipe read and write returns: the meal, one variant's recipe
// (the default unless another was asked for), which variant that is, and all
// of the meal's variants in order. With `all`, each variant carries its full
// recipe too, so a client can cache every variant from one response.
export type RecipeResponse = {
  meal: Meal;
  recipe: StoredRecipe;
  variant: VariantSummary;
  variants: (VariantSummary & { recipe?: StoredRecipe })[];
};
function recipeResponse(meal: Meal, rows: RecipeRow[], row: RecipeRow, all = false): RecipeResponse {
  return {
    meal: { ...meal, hasRecipe: true, variantCount: rows.length },
    recipe: storedRecipe(row),
    variant: variantSummary(row),
    variants: rows.map((entry) => ({ ...variantSummary(entry), ...(all ? { recipe: storedRecipe(entry) } : {}) })),
  };
}
function parseLabel(value: unknown, field = "label", required = true) {
  if (value === undefined || value === null) {
    if (required) throw new RequestError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new RequestError(`${field} must be a string`);
  const label = cleanVariantLabel(value);
  if ((required && !label) || label.length > maxVariantLabelLength)
    throw new RequestError(`${field} must be 1–${maxVariantLabelLength} characters`);
  return label;
}
function checkVariantId(variantId: string) {
  if (!uuidPattern.test(variantId)) throw new RequestError("Invalid variant ID");
}
// A label already used by another variant of the same meal (case ignored).
function labelTaken(rows: RecipeRow[], label: string, except?: string) {
  const key = variantLabelKey(label);
  return rows.find((row) => row.id !== except && variantLabelKey(row.label) === key);
}
export type NewVariant = {
  label: string;
  recipe: Recipe;
  // Label for the meal's existing unlabeled recipe (default "Original").
  existingLabel?: string;
  isDefault?: boolean;
};
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settingsId = "00000000-0000-4000-8000-000000000001";
// Without a week, list from two weeks back: enough for the calendar feed and
// prep reminders without returning the whole history.
const recentDays = 14;
function cleanMealName(name: string, label = "Meal name") {
  name = name.trim().replace(/\s+/g, " ");
  if (!name || name.length > maxMealNameLength)
    throw new Error(`${label} must be 1–${maxMealNameLength} characters`);
  return name;
}
export class Store {
  readonly db;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    this.db = new Persistence(path);
  }
  // One writer within the application.
  write<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.writing.then(fn);
    this.writing = result.catch(() => {});
    return result;
  }
  async seed(demo = true) {
    await this.write(() =>
      this.db.transaction((tx) => {
        if (tx.settingGet(settingsId)) return;
        if (!(tx.slotAll()[0])) {
          for (const [name, time] of [
            ["Breakfast", "08:00"],
            ["Lunch", "13:00"],
            ["Dinner", "19:00"],
            ...(!demo ? [["School snack", "16:00"]] : []),
          ]) {
            tx.slotInsert({ id: randomUUID(), name, time });
          }
        }
        if (demo && !(tx.libraryAll()[0]))
          for (const name of ["Idli & sambar", "Dal & rice", "Vegetable pasta"])
            tx.libraryInsert({ id: randomUUID(), name });
        tx.settingInsert({
          id: settingsId,
          value: JSON.stringify({
            theme: "system",
            slotOrder: [],
            libraryOrder: [],
            aliases: {},
            revision: 0,
          } satisfies Settings),
        });
      }),
    );
  }
  // Library rows with their alternate names, in alias order.
  private libraryMeals(db: Persistence = this.db): Meal[] {
    const aliases = new Map<string, string[]>();
    for (const row of db.libraryAliasAll())
      aliases.set(row.mealId, [...(aliases.get(row.mealId) ?? []), row.name]);
    return db.libraryAll().map((meal) => ({ ...meal, aliases: aliases.get(meal.id) ?? [] }));
  }
  async addLibrary(name: string): Promise<Meal> {
    name = cleanMealName(name);
    return this.write(() =>
      this.db.transaction((tx) => {
        // A name that is already a meal's name or alternate name is that meal.
        const existing = findMealByName(this.libraryMeals(tx), name);
        if (existing) return existing;
        return { ...tx.libraryInsert({ id: randomUUID(), name }), aliases: [] };
      }),
    );
  }
  // Plans a library meal into a slot. The client's request ID becomes the
  // planned meal's id, so repeating the request (after a lost response) finds
  // the meal already there instead of planning it twice.
  async place(input: { requestId: string; mealId: string; slotId: string; date: string }) {
    if (
      !uuidPattern.test(input.requestId) ||
      !uuidPattern.test(input.mealId) ||
      !uuidPattern.test(input.slotId)
    )
      throw new Error("Invalid placement ID");
    if (!validDate(input.date)) throw new Error("Invalid day");
    await this.write(() =>
      this.db.transaction((tx) => {
        if (tx.plannedGet(input.requestId)) return;
        const meal = tx.libraryGet(input.mealId);
        const slot = tx.slotGet(input.slotId);
        if (!meal || !slot) throw new Error("Meal or slot no longer exists");
        tx.plannedInsert({ id: input.requestId, mealId: meal.id, name: meal.name, date: input.date, time: slot.time });
      }),
    );
  }
  // Planned meals for one week, or without a week from two weeks back on (the
  // calendar feed and prep reminders read those).
  private cards(week?: string, now = new Date()): Card[] {
    const from = week ?? addDays(now.toISOString().slice(0, 10), -recentDays);
    const until = week ? addDays(week, 7) : "9999-12-31";
    return this.db.plannedRange(from, until).map((row) => ({
      id: row.id,
      name: row.name,
      date: row.date,
      time: row.time,
      ...(row.mealId ? { mealId: row.mealId } : {}),
      ...(isPastSlot(row.date, row.time, now) ? { completed: true } : {}),
    }));
  }
  async board(week?: string): Promise<Omit<Board, "calendarUrl">> {
    const settings = await this.settings();
    const cards = this.cards(week);
    const slots = this.db.slotAll();
    const library = this.libraryMeals();
    const variantCounts = this.db.recipeCounts();
    for (const card of cards) {
      card.slotId =
        slots.find((slot) => slot.time === card.time)?.id ??
        settings.aliases[card.time];
      const meal = resolveCardMeal(card, library);
      card.libraryMealId = meal?.id ?? null;
      card.variantCount = (meal && variantCounts.get(meal.id)) || 0;
      card.hasRecipe = card.variantCount > 0;
    }
    const sort = <T extends { id: string }>(items: T[], order: string[]) =>
      items.sort((a, b) => {
        const ai = order.indexOf(a.id),
          bi = order.indexOf(b.id);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      });
    return {
      settings,
      library: sort(
        library.map((meal) => ({ ...meal, hasRecipe: variantCounts.has(meal.id), variantCount: variantCounts.get(meal.id) ?? 0 })),
        settings.libraryOrder,
      ),
      slots: sortSlotsByTime(sort(slots, settings.slotOrder)),
      cards,
    };
  }
  async settings(): Promise<Settings> {
    const row = this.db.settingGet(settingsId);
    return row
      ? JSON.parse(row.value)
      : {
          theme: "system",
          slotOrder: [],
          libraryOrder: [],
          aliases: {},
          revision: 0,
        };
  }
  async saveTheme(theme: Settings["theme"]) {
    if (!["system", "light", "dark"].includes(theme))
      throw new Error("Invalid theme");
    return this.write(async () => {
      const settings = { ...(await this.settings()), theme };
      await this.putSettings(settings);
      return settings;
    });
  }
  private async putSettings(settings: Settings) {
    const row = this.db.settingGet(settingsId);
    if (row)
      this.db.settingUpdate(settingsId, {
        value: JSON.stringify(settings),
      });
    else
      this.db.settingInsert({
        id: settingsId,
        value: JSON.stringify(settings),
      });
  }
  // Renames a library meal and, when given, replaces its alternate names.
  // Planned meals keep the name they were planned with.
  async renameLibrary(mealId: string, name: string, aliases?: string[]) {
    if (!uuidPattern.test(mealId)) throw new Error("Invalid meal ID");
    name = cleanMealName(name);
    const key = mealNameKey(name);
    const cleaned = aliases
      ?.map((alias) => cleanMealName(alias, "Alternate names"))
      .filter((alias, index, all) =>
        mealNameKey(alias) !== key &&
        all.findIndex((other) => mealNameKey(other) === mealNameKey(alias)) === index);
    if (cleaned && cleaned.length > maxMealAliases)
      throw new Error(`Use at most ${maxMealAliases} alternate names`);
    return this.write(() =>
      this.db.transaction((tx) => {
        const meals = this.libraryMeals(tx);
        if (!meals.some((meal) => meal.id === mealId)) throw new Error("Meal not found");
        for (const meal of meals) {
          if (meal.id === mealId) continue;
          if (mealNameKey(meal.name) === key) throw new Error("A meal with this name already exists");
          for (const taken of [meal.name, ...meal.aliases])
            for (const wanted of [name, ...(cleaned ?? [])])
              if (mealNameKey(taken) === mealNameKey(wanted))
                throw new Error(`“${wanted}” is already a name for ${meal.name}`);
        }
        tx.libraryUpdate(mealId, { name });
        if (cleaned) tx.libraryAliasReplace(mealId, cleaned);
      }),
    );
  }
  async removeLibrary(mealId: string) {
    if (!uuidPattern.test(mealId)) throw new Error("Invalid meal ID");
    await this.write(() =>
      this.db.libraryDelete(mealId),
    );
  }
  // Library meals with whether each has a recipe, alphabetically; with a name,
  // only the meal that name (or alternate name) resolves to.
  recipeIndex(name?: string): Meal[] {
    const counts = this.db.recipeCounts();
    const library = this.libraryMeals().map((meal) => ({ ...meal, hasRecipe: counts.has(meal.id), variantCount: counts.get(meal.id) ?? 0 }));
    if (name !== undefined) {
      const meal = resolveCardMeal({ name }, library);
      return meal ? [meal] : [];
    }
    return library.sort((a, b) => a.name.localeCompare(b.name));
  }
  private recipeMeal(db: Db, mealId: string): Meal {
    if (!uuidPattern.test(mealId)) throw new RequestError("Invalid meal ID");
    const meal = this.libraryMeals(db).find((entry) => entry.id === mealId);
    if (!meal) throw new RequestError("Meal not found", 404);
    return meal;
  }
  private variant(rows: RecipeRow[], variantId: string) {
    checkVariantId(variantId);
    const row = rows.find((entry) => entry.id === variantId);
    if (!row) throw new RequestError("Variant not found", 404);
    return row;
  }
  // A meal's recipe: the default variant, or `variantId`'s.
  recipe(mealId: string, variantId?: string, all = false): RecipeResponse {
    const meal = this.recipeMeal(this.db, mealId);
    const rows = this.db.recipeVariants(mealId);
    if (!rows.length) throw new RequestError("This meal has no recipe", 404);
    const row = variantId ? this.variant(rows, variantId) : rows.find((entry) => entry.isDefault) ?? rows[0]!;
    return recipeResponse(meal, rows, row, all);
  }
  // Replaces one variant's whole recipe (the default when no variant is
  // given). A meal without a recipe gets it as its single, unlabeled variant.
  async saveRecipe(mealId: string, input: unknown, variantId?: string) {
    if (!uuidPattern.test(mealId)) throw new RequestError("Invalid meal ID");
    if (variantId) checkVariantId(variantId);
    const recipe = parseRecipe(input);
    return this.write(() =>
      this.db.transaction((tx) => {
        const meal = this.recipeMeal(tx, mealId);
        const rows = tx.recipeVariants(mealId);
        if (!rows.length && !variantId) return this.insertVariant(tx, meal, rows, { label: "", recipe, isDefault: true });
        const row = variantId ? this.variant(rows, variantId) : rows.find((entry) => entry.isDefault)!;
        return this.replaceVariant(tx, meal, row.id, recipe);
      }),
    );
  }
  private replaceVariant(tx: Db, meal: Meal, variantId: string, recipe: Recipe, all = false) {
    tx.recipeUpdate(variantId, { body: JSON.stringify(recipe), updatedAt: new Date().toISOString() });
    const rows = tx.recipeVariants(meal.id);
    return recipeResponse(meal, rows, rows.find((entry) => entry.id === variantId)!, all);
  }
  // Adds a variant after the meal's others. When the meal so far has one
  // unlabeled recipe, that one is labelled `existingLabel` (or "Original"),
  // since a meal with several variants needs a label on each.
  private insertVariant(tx: Db, meal: Meal, rows: RecipeRow[], input: NewVariant) {
    if (rows.length >= maxVariants) throw new RequestError(`A meal can have at most ${maxVariants} variants`, 409);
    if (rows.length && !input.label) throw new RequestError("label is required");
    if (input.label && labelTaken(rows, input.label))
      throw new RequestError(`${meal.name} already has a variant called “${labelTaken(rows, input.label)!.label}”`, 409);
    if (rows.length === 1 && !rows[0]!.label) {
      const existing = input.existingLabel || fallbackVariantLabel;
      if (variantLabelKey(existing) === variantLabelKey(input.label))
        throw new RequestError(`The existing recipe and the new variant need different labels`, 409);
      tx.recipeUpdate(rows[0]!.id, { label: existing });
    }
    const row: RecipeRow = {
      id: randomUUID(),
      mealId: meal.id,
      label: input.label,
      isDefault: !rows.length,
      position: Math.max(-1, ...rows.map((entry) => entry.position)) + 1,
      body: JSON.stringify(input.recipe),
      updatedAt: new Date().toISOString(),
    };
    tx.recipeInsert(row);
    if (input.isDefault && rows.length) tx.recipeSetDefault(meal.id, row.id);
    const after = tx.recipeVariants(meal.id);
    return recipeResponse(meal, after, after.find((entry) => entry.id === row.id)!);
  }
  // POST /api/recipes/<mealId>/variants: a new variant with its own whole
  // recipe, or a copy of another variant's (`copyFrom`).
  async addVariant(mealId: string, body: Record<string, unknown>) {
    if (!uuidPattern.test(mealId)) throw new RequestError("Invalid meal ID");
    const allowed = ["label", "recipe", "copyFrom", "existingLabel", "isDefault"];
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new RequestError(`Unknown field "${unknown[0]}" (allowed: ${allowed.join(", ")})`);
    const label = parseLabel(body.label)!;
    const existingLabel = parseLabel(body.existingLabel, "existingLabel", false);
    if (body.isDefault !== undefined && typeof body.isDefault !== "boolean") throw new RequestError("isDefault must be true or false");
    if ((body.recipe === undefined) === (body.copyFrom === undefined)) throw new RequestError("Send either recipe or copyFrom");
    if (body.copyFrom !== undefined && typeof body.copyFrom !== "string") throw new RequestError("copyFrom must be a variant ID");
    const parsed = body.recipe === undefined ? undefined : parseRecipe(body.recipe);
    return this.write(() =>
      this.db.transaction((tx) => {
        const meal = this.recipeMeal(tx, mealId);
        const rows = tx.recipeVariants(mealId);
        const recipe = parsed ?? (JSON.parse(this.variant(rows, body.copyFrom as string).body) as Recipe);
        return this.insertVariant(tx, meal, rows, { label, recipe, existingLabel, isDefault: body.isDefault === true });
      }),
    );
  }
  // PATCH a variant: rename it (`label`) and/or make it the default
  // (`isDefault: true`). A label may be empty only while it is the meal's
  // only variant.
  async updateVariant(mealId: string, variantId: string, body: Record<string, unknown>) {
    if (!uuidPattern.test(mealId)) throw new RequestError("Invalid meal ID");
    checkVariantId(variantId);
    const unknown = Object.keys(body).filter((key) => key !== "label" && key !== "isDefault");
    if (unknown.length) throw new RequestError(`Unknown field "${unknown[0]}" (allowed: label, isDefault)`);
    if (body.isDefault !== undefined && body.isDefault !== true)
      throw new RequestError("isDefault can only be set to true; make another variant the default instead");
    const label = parseLabel(body.label, "label", false);
    if (label === undefined && body.isDefault === undefined) throw new RequestError("Send label and/or isDefault");
    return this.write(() =>
      this.db.transaction((tx) => {
        const meal = this.recipeMeal(tx, mealId);
        const rows = tx.recipeVariants(mealId);
        const row = this.variant(rows, variantId);
        if (label !== undefined) {
          if (!label && rows.length > 1) throw new RequestError("label must be 1–40 characters while the meal has several variants");
          const taken = label && labelTaken(rows, label, row.id);
          if (taken) throw new RequestError(`${meal.name} already has a variant called “${taken.label}”`, 409);
          if (label !== row.label) tx.recipeUpdate(row.id, { label });
        }
        if (body.isDefault === true && !row.isDefault) tx.recipeSetDefault(mealId, row.id);
        const after = tx.recipeVariants(mealId);
        return recipeResponse(meal, after, after.find((entry) => entry.id === row.id)!);
      }),
    );
  }
  // Removes one variant. Removing the default makes the first remaining
  // variant the default; removing the last leaves the meal without a recipe.
  // An unknown variant answers deleted: false, so repeating a delete is safe.
  async deleteVariant(mealId: string, variantId: string) {
    if (!uuidPattern.test(mealId)) throw new RequestError("Invalid meal ID");
    checkVariantId(variantId);
    return this.write(() =>
      this.db.transaction((tx) => {
        this.recipeMeal(tx, mealId);
        const row = tx.recipeVariants(mealId).find((entry) => entry.id === variantId);
        if (!row) return this.afterDelete(tx, mealId, false);
        tx.recipeDeleteVariant(row.id);
        return this.afterDelete(tx, mealId, true);
      }),
    );
  }
  private afterDelete(tx: Db, mealId: string, deleted: boolean) {
    let rows = tx.recipeVariants(mealId);
    if (rows.length && !rows.some((entry) => entry.isDefault)) {
      tx.recipeSetDefault(mealId, rows[0]!.id);
      rows = tx.recipeVariants(mealId);
    }
    return { deleted, variants: rows.map(variantSummary) };
  }
  // For assistants adding "a recipe for X": finds the library meal by name or
  // alternate name, creating it when missing, and saves its recipe. Without
  // `variant` this is the meal's default recipe, replaced only when `replace`
  // is true. With `variant` (a label) it is that variant: added when the meal
  // has none by that label, else replaced only when `replace` is true.
  async saveRecipeByName(name: unknown, input: unknown, replace: boolean, variant?: unknown, existingLabel?: unknown) {
    if (typeof name !== "string") throw new RequestError("name is required");
    const cleaned = cleanMealName(name);
    const label = parseLabel(variant, "variant", false);
    const existing = parseLabel(existingLabel, "existingLabel", false);
    const recipe = parseRecipe(input);
    return this.write(() =>
      this.db.transaction((tx) => {
        let meal = findMealByName(this.libraryMeals(tx), cleaned);
        const rows = meal ? tx.recipeVariants(meal.id) : [];
        const target = label ? labelTaken(rows, label) : rows.find((entry) => entry.isDefault);
        if (meal && target && !replace)
          throw new RequestError(
            label
              ? `${meal.name} already has a “${target.label}” variant. Send "replace": true to overwrite it, or PUT /api/recipes/${meal.id}/variants/${target.id}`
              : `${meal.name} already has a recipe. Send "replace": true to overwrite it, or PUT /api/recipes/${meal.id}`,
            409,
          );
        const created = !meal;
        meal ??= { ...tx.libraryInsert({ id: randomUUID(), name: cleaned }), aliases: [] };
        const saved = target
          ? this.replaceVariant(tx, meal, target.id, recipe)
          : this.insertVariant(tx, meal, rows, { label: label ?? "", recipe, existingLabel: existing });
        return { created, ...saved };
      }),
    );
  }
  // DELETE /api/recipes/<mealId>: removes the default variant (the whole
  // recipe of a single-recipe meal), or with `all` every variant.
  async deleteRecipe(mealId: string, all = false) {
    if (!uuidPattern.test(mealId)) throw new RequestError("Invalid meal ID");
    return this.write(() =>
      this.db.transaction((tx) => {
        this.recipeMeal(tx, mealId);
        if (all) return this.afterDelete(tx, mealId, tx.recipeDeleteMeal(mealId) > 0);
        const row = tx.recipeVariants(mealId).find((entry) => entry.isDefault);
        if (row) tx.recipeDeleteVariant(row.id);
        return this.afterDelete(tx, mealId, !!row);
      }),
    );
  }
  // Prep reminders due in [from, to) for planned meals from two weeks back on.
  // Only each meal's default variant counts: the variant is chosen at the stove.
  async prep(from: number, to: number, includeOverdue = false) {
    const board = await this.board();
    const recipes = new Map(this.db.recipeDefaults().map((row) => [row.mealId, storedRecipe(row)] as const));
    return prepReminders(board.cards, board.slots, board.library, recipes, from, to, includeOverdue);
  }
  async shuffle() {
    return this.write(async () => {
      const order = (this.db.libraryAll()).map((meal) => meal.id);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      await this.putSettings({
        ...(await this.settings()),
        libraryOrder: order,
      });
    });
  }
  // Moves a planned meal to another day/slot, or deletes it. Repeating a move
  // just sets the same day and time again; deleting a meal that is already
  // gone succeeds.
  async change(input: {
    taskId: string;
    kind: "move" | "delete";
    slotId?: string;
    date?: string;
  }) {
    if (!input.taskId.trim() || input.taskId.length > 200)
      throw new Error("Invalid operation ID");
    await this.write(() =>
      this.db.transaction((tx) => {
        if (input.kind === "delete") return tx.plannedDelete(input.taskId);
        const slot = tx.slotGet(input.slotId ?? "");
        if (!slot || !validDate(input.date ?? "")) throw new Error("Invalid destination");
        if (!tx.plannedMove(input.taskId, input.date!, slot.time))
          throw new RequestError("This meal no longer exists", 404);
      }),
    );
  }
  async saveSlots(slots: Slot[], revision: number) {
    if (
      !slots.length ||
      slots.length > 12 ||
      slots.some(
        (slot) =>
          !uuidPattern.test(slot.id) ||
          !slot.name.trim() ||
          slot.name.length > 120 ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time),
      ) ||
      new Set(slots.map((slot) => slot.id)).size !== slots.length ||
      new Set(slots.map((slot) => slot.time)).size !== slots.length
    )
      throw new Error("Every slot needs a name and unique time");
    slots = sortSlotsByTime(slots);
    return this.write(async () => {
      const settings = await this.settings();
      if (settings.revision !== revision)
        throw new Error("Settings changed elsewhere. Reload before saving");
      const old = this.db.slotAll();
      // Meals still to come follow their slot to its new time. Eaten meals keep
      // their time and find their slot through the alias recorded below.
      const now = new Date();
      const open = this.cards(undefined, now).filter((card) => !card.completed);
      for (const removed of old.filter(
        (slot) => !slots.some((next) => next.id === slot.id),
      )) {
        const times = [
          removed.time,
          ...Object.entries(settings.aliases)
            .filter(([, id]) => id === removed.id)
            .map(([time]) => time),
        ];
        if (open.some((card) => times.includes(card.time)))
          throw new Error(
            `Move or complete active ${removed.name} meals before removing this slot`,
          );
      }
      const aliases: Record<string, string> = Object.fromEntries(
        Object.entries(settings.aliases).filter(([, id]) =>
          slots.some((slot) => slot.id === id),
        ),
      );
      // Worked out from the snapshot above and applied by id, so two slots
      // swapping times cannot move each other's meals twice.
      const moves: { id: string; date: string; time: string }[] = [];
      for (const slot of slots) {
        const previous = old.find((item) => item.id === slot.id);
        if (!previous) continue;
        if (previous.time !== slot.time) aliases[previous.time] = slot.id;
        for (const card of open)
          if (
            validDate(card.date) &&
            card.time !== slot.time &&
            (old.find((item) => item.time === card.time)?.id ??
              settings.aliases[card.time]) === slot.id
          )
            moves.push({ id: card.id, date: card.date, time: slot.time });
      }
      this.db.transaction((tx) => {
        for (const move of moves) tx.plannedMove(move.id, move.date, move.time);
        for (const previous of old) tx.slotDelete(previous.id);
        for (const slot of slots)
          tx.slotInsert({ ...slot, id: slot.id, name: slot.name.trim() });
        const next = {
          ...settings,
          aliases,
          slotOrder: slots.map((slot) => slot.id),
          revision: revision + 1,
        };
        if (tx.settingGet(settingsId))
          tx.settingUpdate(settingsId, { value: JSON.stringify(next) });
        else tx.settingInsert({ id: settingsId, value: JSON.stringify(next) });
      });
      return this.settings();
    });
  }
  async close() {
    await this.writing;
    this.db.close();
  }
}
function validDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date + "T12:00:00Z")) &&
    new Date(date + "T12:00:00Z").toISOString().slice(0, 10) === date
  );
}
