import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";

export type LibraryRow = { id: string; name: string };
export type LibraryAliasRow = { mealId: string; name: string };
export type SlotRow = { id: string; name: string; time: string };
// A meal planned into a slot. `mealId` is the library meal it was planned from
// (null for meals planned before that was recorded, or whose meal was removed:
// there is deliberately no foreign key, so a planned meal outlives its library
// meal). Completion is not stored; it follows the clock (see isPastSlot).
export type PlannedRow = { id: string; mealId: string | null; name: string; date: string; time: string };
export type SettingRow = { id: string; value: string };
// One recipe variant of a library meal. A meal with a recipe has one or more
// variants ("Non-fry", "Fry"), exactly one of them the default. A meal with a
// single recipe has one variant, usually with an empty label.
export type RecipeRow = { id: string; mealId: string; label: string; isDefault: boolean; position: number; body: string; updatedAt: string };

export const schemaVersion = 3;
const recipeTable = '"recipe" ("id" CHARACTER NOT NULL PRIMARY KEY, "mealId" CHARACTER NOT NULL REFERENCES "library" ("id") ON DELETE CASCADE, "label" TEXT NOT NULL, "isDefault" INTEGER NOT NULL, "position" INTEGER NOT NULL, "body" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)';
const recipeColumns = '"id", "mealId", "label", "isDefault", "position", "body", "updatedAt"';
function recipeRow(row: Record<string, unknown>): RecipeRow {
  return { id: String(row.id), mealId: String(row.mealId), label: String(row.label), isDefault: Number(row.isDefault) === 1, position: Number(row.position), body: String(row.body), updatedAt: String(row.updatedAt) };
}

// SQL identifiers below are fixed application constants; values always use bindings.
// Version 1 adopts the original text/CHARACTER tables without rewriting their rows.
// Version 2 turns the one-recipe-per-meal "recipe" table into recipe variants;
// each existing recipe becomes its meal's single, unlabeled default variant.
// Version 3 drops the Todoist-era write path: planned meals move from JSON
// bodies in "local_meal" into the "planned_meal" table, and the "outbox",
// "local_receipt" and retired login "session" tables are dropped. A copy of the
// database is taken first (`<path>.pre-v3`); an older build refuses version 3,
// so that copy is the rollback.
export class Persistence {
  private readonly connection: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
      const version = Number(this.connection.prepare("PRAGMA user_version").get()!.user_version);
      if (version > schemaVersion) throw new Error(`Unsupported database version ${version}`);
      if (version < 3) this.backupBeforeV3(path);
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        this.connection.exec('CREATE TABLE IF NOT EXISTS "library" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)');
        // Alternate meal names. A separate table leaves the original library rows
        // untouched, so an older build still reads this database.
        this.connection.exec('CREATE TABLE IF NOT EXISTS "library_alias" ("mealId" CHARACTER NOT NULL REFERENCES "library" ("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "position" INTEGER NOT NULL, PRIMARY KEY ("mealId", "position"))');
        this.migrateRecipes();
        this.connection.exec('CREATE TABLE IF NOT EXISTS "slot" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "time" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "setting" ("id" CHARACTER NOT NULL PRIMARY KEY, "value" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "planned_meal" ("id" CHARACTER NOT NULL PRIMARY KEY, "mealId" CHARACTER, "name" TEXT NOT NULL, "date" TEXT NOT NULL, "time" TEXT NOT NULL)');
        this.connection.exec('CREATE INDEX IF NOT EXISTS "planned_meal_date" ON "planned_meal" ("date")');
        if (version < 3) this.migratePlannedMeals();
        this.connection.exec(`PRAGMA user_version=${schemaVersion}; COMMIT`);
      } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
    } catch (error) { this.connection.close(); throw error; }
  }
  private hasTable(name: string) {
    return !!this.connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }
  // A consistent copy of an existing pre-v3 database, kept beside it. VACUUM
  // cannot run inside a transaction, so this happens before the migration; the
  // temporary name means a copy cut short is never taken for a good one.
  private backupBeforeV3(path: string) {
    if (path === ":memory:" || !this.connection.prepare("SELECT 1 FROM sqlite_master").get()) return;
    const target = `${path}.pre-v3`;
    if (existsSync(target)) return;
    const temporary = `${target}.tmp`;
    rmSync(temporary, { force: true });
    this.connection.prepare("VACUUM INTO ?").run(temporary);
    renameSync(temporary, target);
  }
  // Copies each local_meal JSON body into planned_meal, keeping its id (the
  // calendar feed's UID), then drops the Todoist-era tables. Outbox rows that
  // were never saved are logged, since dropping them discards that intent.
  private migratePlannedMeals() {
    let copied = 0, found = 0;
    if (this.hasTable("local_meal")) {
      const insert = this.connection.prepare('INSERT INTO "planned_meal" ("id", "mealId", "name", "date", "time") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("id") DO NOTHING');
      for (const row of this.connection.prepare('SELECT "id", "body" FROM "local_meal"').all()) {
        found++;
        const meal = JSON.parse(String(row.body)) as { name?: string; date?: string; time?: string; mealId?: string };
        copied += Number(insert.run(String(row.id), meal.mealId ?? null, meal.name ?? "", meal.date ?? "", meal.time ?? "").changes);
      }
    }
    let outbox = 0;
    const unsaved: string[] = [];
    if (this.hasTable("outbox")) {
      for (const row of this.connection.prepare('SELECT "id", "payload", "state" FROM "outbox"').all()) {
        outbox++;
        if (row.state !== "saved") unsaved.push(`${String(row.id)} ${String(row.payload)}`);
      }
    }
    for (const table of ["outbox", "local_receipt", "local_meal", "session"])
      this.connection.exec(`DROP TABLE IF EXISTS "${table}"`);
    if (found || outbox)
      console.log(`planner: schema v3: local_meal ${found} → planned_meal ${copied}; outbox dropped ${outbox} (${unsaved.length} not saved)`);
    for (const line of unsaved) console.log(`planner: dropped unsaved outbox row ${line}`);
  }
  // Recipes (JSON bodies) belong to library meals; removing a meal removes them.
  // The first recipes build (schema 1) kept one row per meal keyed by mealId;
  // that table is rebuilt in place, each row becoming the meal's default
  // variant with its body and updatedAt unchanged. Safe to run again.
  private migrateRecipes() {
    const columns = this.connection.prepare('PRAGMA table_info("recipe")').all().map((row) => String(row.name));
    if (columns.length && !columns.includes("id")) {
      this.connection.exec('ALTER TABLE "recipe" RENAME TO "recipe_v1"');
      this.connection.exec("CREATE TABLE " + recipeTable);
      const insert = this.connection.prepare('INSERT INTO "recipe" (' + recipeColumns + ') VALUES (?, ?, \'\', 1, 0, ?, ?)');
      for (const row of this.connection.prepare('SELECT "mealId", "body", "updatedAt" FROM "recipe_v1"').all())
        insert.run(randomUUID(), String(row.mealId), String(row.body), String(row.updatedAt));
      this.connection.exec('DROP TABLE "recipe_v1"');
    } else this.connection.exec("CREATE TABLE IF NOT EXISTS " + recipeTable);
    this.connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS "recipe_default" ON "recipe" ("mealId") WHERE "isDefault" = 1');
    this.connection.exec('CREATE INDEX IF NOT EXISTS "recipe_meal" ON "recipe" ("mealId", "position")');
  }
  private prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.connection.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  // Called only within Store.write. Callbacks contain database work, never network IO.
  transaction<T>(fn: (db: Persistence) => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try { const result = fn(this); this.connection.exec("COMMIT"); return result; }
    catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }
  close() { this.connection.close(); }
  libraryAll(): LibraryRow[] { return this.prepare('SELECT "id", "name" FROM "library"').all().map(row => ({ ...row })) as LibraryRow[]; }
  libraryGet(id: string): LibraryRow | undefined { const row = this.prepare('SELECT "id", "name" FROM "library" WHERE id = ?').get(id); return row ? { ...row } as LibraryRow : undefined; }
  libraryInsert(input: Omit<LibraryRow, "id"> & { id?: string }): LibraryRow {
    const row = { ...input, id: input.id ?? randomUUID() };
    this.prepare('INSERT INTO "library" ("id", "name") VALUES (?, ?)').run(row.id, row.name);
    return row;
  }
  libraryDelete(id: string) { this.prepare('DELETE FROM "library" WHERE id = ?').run(id); }
  libraryUpdate(id: string, patch: Partial<Omit<LibraryRow, "id">>) {
    const columns = ["name"].filter(column => patch[column as keyof typeof patch] !== undefined);
    if (!columns.length) return;
    this.prepare('UPDATE "library" SET ' + columns.map(column => '"' + column + '" = ?').join(', ') + ' WHERE id = ?')
      .run(...columns.map(column => patch[column as keyof typeof patch]!), id);
  }
  libraryAliasAll(): LibraryAliasRow[] { return this.prepare('SELECT "mealId", "name" FROM "library_alias" ORDER BY "mealId", "position"').all().map(row => ({ ...row })) as LibraryAliasRow[]; }
  libraryAliasReplace(mealId: string, names: string[]) {
    this.prepare('DELETE FROM "library_alias" WHERE "mealId" = ?').run(mealId);
    names.forEach((name, position) => this.prepare('INSERT INTO "library_alias" ("mealId", "name", "position") VALUES (?, ?, ?)').run(mealId, name, position));
  }
  // Variants of one meal in display order.
  recipeVariants(mealId: string): RecipeRow[] { return this.prepare('SELECT ' + recipeColumns + ' FROM "recipe" WHERE "mealId" = ? ORDER BY "position", "rowid"').all(mealId).map(recipeRow); }
  // Every meal's default variant (prep reminders use only these).
  recipeDefaults(): RecipeRow[] { return this.prepare('SELECT ' + recipeColumns + ' FROM "recipe" WHERE "isDefault" = 1').all().map(recipeRow); }
  // How many variants each meal with a recipe has.
  recipeCounts(): Map<string, number> { return new Map(this.prepare('SELECT "mealId", count(*) AS "n" FROM "recipe" GROUP BY "mealId"').all().map((row) => [String(row.mealId), Number(row.n)] as const)); }
  recipeInsert(row: RecipeRow) {
    this.prepare('INSERT INTO "recipe" (' + recipeColumns + ') VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.mealId, row.label, row.isDefault ? 1 : 0, row.position, row.body, row.updatedAt);
  }
  recipeUpdate(id: string, patch: Partial<Pick<RecipeRow, "label" | "body" | "updatedAt">>) {
    const columns = (["label", "body", "updatedAt"] as const).filter((column) => patch[column] !== undefined);
    if (!columns.length) return;
    this.prepare('UPDATE "recipe" SET ' + columns.map((column) => '"' + column + '" = ?').join(', ') + ' WHERE "id" = ?')
      .run(...columns.map((column) => patch[column]!), id);
  }
  // Makes one variant its meal's default (clearing the old one first, so the
  // one-default index holds throughout).
  recipeSetDefault(mealId: string, id: string) {
    this.prepare('UPDATE "recipe" SET "isDefault" = 0 WHERE "mealId" = ? AND "isDefault" = 1').run(mealId);
    this.prepare('UPDATE "recipe" SET "isDefault" = 1 WHERE "mealId" = ? AND "id" = ?').run(mealId, id);
  }
  recipeDeleteVariant(id: string): boolean { return Number(this.prepare('DELETE FROM "recipe" WHERE "id" = ?').run(id).changes) > 0; }
  recipeDeleteMeal(mealId: string): number { return Number(this.prepare('DELETE FROM "recipe" WHERE "mealId" = ?').run(mealId).changes); }
  slotAll(): SlotRow[] { return this.prepare('SELECT "id", "name", "time" FROM "slot"').all().map(row => ({ ...row })) as SlotRow[]; }
  slotGet(id: string): SlotRow | undefined { const row = this.prepare('SELECT "id", "name", "time" FROM "slot" WHERE id = ?').get(id); return row ? { ...row } as SlotRow : undefined; }
  slotInsert(input: Omit<SlotRow, "id"> & { id?: string }): SlotRow {
    const row = { ...input, id: input.id ?? randomUUID() };
    this.prepare('INSERT INTO "slot" ("id", "name", "time") VALUES (?, ?, ?)').run(row.id, row.name, row.time);
    return row;
  }
  slotDelete(id: string) { this.prepare('DELETE FROM "slot" WHERE id = ?').run(id); }
  // Planned meals dated in [from, until).
  plannedRange(from: string, until: string): PlannedRow[] {
    return this.prepare('SELECT "id", "mealId", "name", "date", "time" FROM "planned_meal" WHERE "date" >= ? AND "date" < ? ORDER BY "date", "time", "rowid"').all(from, until).map(row => ({ ...row })) as PlannedRow[];
  }
  plannedGet(id: string): PlannedRow | undefined { const row = this.prepare('SELECT "id", "mealId", "name", "date", "time" FROM "planned_meal" WHERE "id" = ?').get(id); return row ? { ...row } as PlannedRow : undefined; }
  // False when a meal with this id already exists (a repeated request).
  plannedInsert(row: PlannedRow): boolean {
    return Number(this.prepare('INSERT INTO "planned_meal" ("id", "mealId", "name", "date", "time") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("id") DO NOTHING').run(row.id, row.mealId, row.name, row.date, row.time).changes) > 0;
  }
  plannedMove(id: string, date: string, time: string): boolean {
    return Number(this.prepare('UPDATE "planned_meal" SET "date" = ?, "time" = ? WHERE "id" = ?').run(date, time, id).changes) > 0;
  }
  plannedDelete(id: string) { this.prepare('DELETE FROM "planned_meal" WHERE "id" = ?').run(id); }
  settingAll(): SettingRow[] { return this.prepare('SELECT "id", "value" FROM "setting"').all().map(row => ({ ...row })) as SettingRow[]; }
  settingGet(id: string): SettingRow | undefined { const row = this.prepare('SELECT "id", "value" FROM "setting" WHERE id = ?').get(id); return row ? { ...row } as SettingRow : undefined; }
  settingInsert(input: Omit<SettingRow, "id"> & { id?: string }): SettingRow {
    const row = { ...input, id: input.id ?? randomUUID() };
    this.prepare('INSERT INTO "setting" ("id", "value") VALUES (?, ?)').run(row.id, row.value);
    return row;
  }
  settingUpdate(id: string, patch: Partial<Omit<SettingRow, "id">>) {
    const columns = ["value"].filter(column => patch[column as keyof typeof patch] !== undefined);
    if (!columns.length) return;
    this.prepare('UPDATE "setting" SET ' + columns.map(column => '"' + column + '" = ?').join(', ') + ' WHERE id = ?')
      .run(...columns.map(column => patch[column as keyof typeof patch]!), id);
  }
}
