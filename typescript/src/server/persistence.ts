import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type LibraryRow = { id: string; name: string };
export type LibraryAliasRow = { mealId: string; name: string };
export type SlotRow = { id: string; name: string; time: string };
export type LocalMealRow = { id: string; body: string };
export type LocalReceiptRow = { id: string; body: string };
export type OutboxRow = { id: string; payload: string; state: string; error: string; remoteId: string; attempted: string; nextAt: string; confirmedAt: string };
export type SettingRow = { id: string; value: string };
// One recipe variant of a library meal. A meal with a recipe has one or more
// variants ("Non-fry", "Fry"), exactly one of them the default. A meal with a
// single recipe has one variant, usually with an empty label.
export type RecipeRow = { id: string; mealId: string; label: string; isDefault: boolean; position: number; body: string; updatedAt: string };

export const schemaVersion = 2;
const recipeTable = '"recipe" ("id" CHARACTER NOT NULL PRIMARY KEY, "mealId" CHARACTER NOT NULL REFERENCES "library" ("id") ON DELETE CASCADE, "label" TEXT NOT NULL, "isDefault" INTEGER NOT NULL, "position" INTEGER NOT NULL, "body" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)';
const recipeColumns = '"id", "mealId", "label", "isDefault", "position", "body", "updatedAt"';
function recipeRow(row: Record<string, unknown>): RecipeRow {
  return { id: String(row.id), mealId: String(row.mealId), label: String(row.label), isDefault: Number(row.isDefault) === 1, position: Number(row.position), body: String(row.body), updatedAt: String(row.updatedAt) };
}

// SQL identifiers below are fixed application constants; values always use bindings.
// Version 1 adopts the original text/CHARACTER tables without rewriting their rows.
// Version 2 turns the one-recipe-per-meal "recipe" table into recipe variants;
// each existing recipe becomes its meal's single, unlabeled default variant.
export class Persistence {
  private readonly connection: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
      const version = Number(this.connection.prepare("PRAGMA user_version").get()!.user_version);
      if (version > schemaVersion) throw new Error(`Unsupported database version ${version}`);
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        this.connection.exec('CREATE TABLE IF NOT EXISTS "library" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)');
        // Alternate meal names. A separate table leaves the original library rows
        // untouched, so an older build still reads this database.
        this.connection.exec('CREATE TABLE IF NOT EXISTS "library_alias" ("mealId" CHARACTER NOT NULL REFERENCES "library" ("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "position" INTEGER NOT NULL, PRIMARY KEY ("mealId", "position"))');
        this.migrateRecipes();
        this.connection.exec('CREATE TABLE IF NOT EXISTS "slot" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "time" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "local_meal" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "local_receipt" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "outbox" ("id" CHARACTER NOT NULL PRIMARY KEY, "payload" TEXT NOT NULL, "state" TEXT NOT NULL, "error" TEXT NOT NULL, "remoteId" TEXT NOT NULL, "attempted" TEXT NOT NULL, "nextAt" TEXT NOT NULL, "confirmedAt" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "setting" ("id" CHARACTER NOT NULL PRIMARY KEY, "value" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "session" ("id" CHARACTER NOT NULL PRIMARY KEY, "csrf" TEXT NOT NULL, "expiresAt" TEXT NOT NULL)');
        this.connection.exec(`PRAGMA user_version=${schemaVersion}; COMMIT`);
      } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
    } catch (error) { this.connection.close(); throw error; }
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
  localMealAll(): LocalMealRow[] { return this.prepare('SELECT "id", "body" FROM "local_meal"').all().map(row => ({ ...row })) as LocalMealRow[]; }
  localMealGet(id: string): LocalMealRow | undefined { const row = this.prepare('SELECT "id", "body" FROM "local_meal" WHERE id = ?').get(id); return row ? { ...row } as LocalMealRow : undefined; }
  localMealInsert(input: Omit<LocalMealRow, "id"> & { id?: string }): LocalMealRow {
    const row = { ...input, id: input.id ?? randomUUID() };
    this.prepare('INSERT INTO "local_meal" ("id", "body") VALUES (?, ?)').run(row.id, row.body);
    return row;
  }
  localMealDelete(id: string) { this.prepare('DELETE FROM "local_meal" WHERE id = ?').run(id); }
  localMealUpdate(id: string, patch: Partial<Omit<LocalMealRow, "id">>) {
    const columns = ["body"].filter(column => patch[column as keyof typeof patch] !== undefined);
    if (!columns.length) return;
    this.prepare('UPDATE "local_meal" SET ' + columns.map(column => '"' + column + '" = ?').join(', ') + ' WHERE id = ?')
      .run(...columns.map(column => patch[column as keyof typeof patch]!), id);
  }
  localReceiptGet(id: string): LocalReceiptRow | undefined { const row = this.prepare('SELECT "id", "body" FROM "local_receipt" WHERE id = ?').get(id); return row ? { ...row } as LocalReceiptRow : undefined; }
  localReceiptInsert(input: Omit<LocalReceiptRow, "id"> & { id?: string }): LocalReceiptRow {
    const row = { ...input, id: input.id ?? randomUUID() };
    this.prepare('INSERT INTO "local_receipt" ("id", "body") VALUES (?, ?)').run(row.id, row.body);
    return row;
  }
  outboxAll(): OutboxRow[] { return this.prepare('SELECT "id", "payload", "state", "error", "remoteId", "attempted", "nextAt", "confirmedAt" FROM "outbox"').all().map(row => ({ ...row })) as OutboxRow[]; }
  outboxGet(id: string): OutboxRow | undefined { const row = this.prepare('SELECT "id", "payload", "state", "error", "remoteId", "attempted", "nextAt", "confirmedAt" FROM "outbox" WHERE id = ?').get(id); return row ? { ...row } as OutboxRow : undefined; }
  outboxInsert(input: Omit<OutboxRow, "id"> & { id?: string }): OutboxRow {
    const row = { ...input, id: input.id ?? randomUUID() };
    this.prepare('INSERT INTO "outbox" ("id", "payload", "state", "error", "remoteId", "attempted", "nextAt", "confirmedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.payload, row.state, row.error, row.remoteId, row.attempted, row.nextAt, row.confirmedAt);
    return row;
  }
  outboxUpdate(id: string, patch: Partial<Omit<OutboxRow, "id">>) {
    const columns = ["payload", "state", "error", "remoteId", "attempted", "nextAt", "confirmedAt"].filter(column => patch[column as keyof typeof patch] !== undefined);
    if (!columns.length) return;
    this.prepare('UPDATE "outbox" SET ' + columns.map(column => '"' + column + '" = ?').join(', ') + ' WHERE id = ?')
      .run(...columns.map(column => patch[column as keyof typeof patch]!), id);
  }
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
  // Drops acknowledged outbox rows older than `before` (ms), receipts that no
  // longer belong to an outbox row, and rows left from the retired login.
  outboxPrune(before: number) {
    this.prepare('DELETE FROM "outbox" WHERE "state" = \'saved\' AND CAST("confirmedAt" AS INTEGER) < ?').run(before);
    this.prepare('DELETE FROM "local_receipt" WHERE "id" NOT IN (SELECT "id" FROM "outbox")').run();
    this.prepare('DELETE FROM "session"').run();
  }
}
