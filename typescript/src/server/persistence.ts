import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type LibraryRow = { id: string; name: string };
export type SlotRow = { id: string; name: string; time: string };
export type LocalMealRow = { id: string; body: string };
export type LocalReceiptRow = { id: string; body: string };
export type OutboxRow = { id: string; payload: string; state: string; error: string; remoteId: string; attempted: string; nextAt: string; confirmedAt: string };
export type SettingRow = { id: string; value: string };

// SQL identifiers below are fixed application constants; values always use bindings.
// Version 1 adopts the original text/CHARACTER tables without rewriting their rows.
export class Persistence {
  private readonly connection: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
      const version = Number(this.connection.prepare("PRAGMA user_version").get()!.user_version);
      if (version > 1) throw new Error(`Unsupported database version ${version}`);
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        this.connection.exec('CREATE TABLE IF NOT EXISTS "library" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "slot" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "time" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "local_meal" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "local_receipt" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "outbox" ("id" CHARACTER NOT NULL PRIMARY KEY, "payload" TEXT NOT NULL, "state" TEXT NOT NULL, "error" TEXT NOT NULL, "remoteId" TEXT NOT NULL, "attempted" TEXT NOT NULL, "nextAt" TEXT NOT NULL, "confirmedAt" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "setting" ("id" CHARACTER NOT NULL PRIMARY KEY, "value" TEXT NOT NULL)');
        this.connection.exec('CREATE TABLE IF NOT EXISTS "session" ("id" CHARACTER NOT NULL PRIMARY KEY, "csrf" TEXT NOT NULL, "expiresAt" TEXT NOT NULL)');
        this.connection.exec("PRAGMA user_version=1; COMMIT");
      } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
    } catch (error) { this.connection.close(); throw error; }
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
