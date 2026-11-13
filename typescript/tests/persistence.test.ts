import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/server/persistence";

// Synthetic schema captured from the former text-UUID contract, including its
// alphabetic Outbox column order and opaque metadata. No deployment data used.
test("adopt original schema: keep data and metadata, drop the Todoist-era tables, back up first", (t) => {
  const log = t.mock.method(console, "log", () => {});
  const dir = mkdtempSync(join(tmpdir(), "planner-compat-"));
  const path = join(dir, "old.sqlite");
  const mealId = randomUUID(), requestId = randomUUID(), sessionId = randomUUID();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE library(id CHARACTER NOT NULL PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE slot(id CHARACTER NOT NULL PRIMARY KEY,name TEXT NOT NULL,time TEXT NOT NULL);
    CREATE TABLE setting(id CHARACTER NOT NULL PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE session(id CHARACTER NOT NULL PRIMARY KEY,csrf TEXT NOT NULL,expiresAt TEXT NOT NULL);
    CREATE TABLE outbox(attempted TEXT NOT NULL,confirmedAt TEXT NOT NULL,error TEXT NOT NULL,id CHARACTER NOT NULL PRIMARY KEY,nextAt TEXT NOT NULL,payload TEXT NOT NULL,remoteId TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE _prisma_marker(value TEXT); CREATE TABLE _prisma_ledger(value TEXT);
    INSERT INTO _prisma_marker VALUES('synthetic marker'); INSERT INTO _prisma_ledger VALUES('synthetic ledger');`);
  old.prepare("INSERT INTO library VALUES (?,?)").run(mealId, "Old meal");
  old.prepare("INSERT INTO session VALUES (?,?,?)").run(sessionId, "csrf", "9999999999999");
  old.prepare("INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?)").run("2", "0", "retry", requestId, "123", "{}", "remote", "pending");
  const kept = ["library", "slot", "setting", "_prisma_marker", "_prisma_ledger"].map(table => [table, old.prepare(`SELECT * FROM ${table}`).all()] as const);
  old.close();
  try {
    const db = new Persistence(path);
    assert.equal(db.libraryGet(mealId)?.name, "Old meal");
    db.close();
    const check = new DatabaseSync(path);
    for (const [table, rows] of kept) assert.deepEqual(check.prepare(`SELECT * FROM ${table}`).all(), rows);
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    for (const gone of ["outbox", "session", "local_meal", "local_receipt"]) assert.ok(!tables.includes(gone), gone);
    assert.equal(check.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 3);
    check.close();
    // The copy taken before migrating still has the dropped rows.
    const backup = new DatabaseSync(`${path}.pre-v3`);
    assert.equal(backup.prepare("SELECT state FROM outbox WHERE id = ?").get(requestId)!.state, "pending");
    backup.close();
    assert.ok(!existsSync(`${path}.pre-v3.tmp`));
    assert.ok(log.mock.calls.some(call => String(call.arguments[0]).includes(`dropped unsaved outbox row ${requestId}`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("v2 planned meals move into planned_meal with their ids; restart and a second start change nothing", (t) => {
  const log = t.mock.method(console, "log", () => {});
  const dir = mkdtempSync(join(tmpdir(), "planner-v3-"));
  const path = join(dir, "v2.sqlite");
  const withMeal = randomUUID(), legacy = randomUUID(), library = randomUUID(), request = randomUUID();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE "library" ("id" CHARACTER NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "local_meal" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL);
    CREATE TABLE "local_receipt" ("id" CHARACTER NOT NULL PRIMARY KEY, "body" TEXT NOT NULL);
    CREATE TABLE "outbox" ("id" CHARACTER NOT NULL PRIMARY KEY, "payload" TEXT NOT NULL, "state" TEXT NOT NULL, "error" TEXT NOT NULL, "remoteId" TEXT NOT NULL, "attempted" TEXT NOT NULL, "nextAt" TEXT NOT NULL, "confirmedAt" TEXT NOT NULL);
    PRAGMA user_version=2;`);
  old.prepare('INSERT INTO "library" VALUES (?, ?)').run(library, "Dosa");
  old.prepare('INSERT INTO "local_meal" VALUES (?, ?)').run(withMeal, JSON.stringify({ id: withMeal, projectId: "local-meals", name: "Dosa", date: "2030-01-07", time: "08:00", requestId: request, mealId: library }));
  // Planned before cards recorded their library meal.
  old.prepare('INSERT INTO "local_meal" VALUES (?, ?)').run(legacy, JSON.stringify({ id: legacy, projectId: "local-meals", name: "Pongal", date: "2030-01-08", time: "19:30", requestId: randomUUID() }));
  old.prepare('INSERT INTO "local_receipt" VALUES (?, ?)').run(request, "{}");
  old.prepare('INSERT INTO "outbox" VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(request, "{}", "saved", "", withMeal, "1", "0", "1");
  old.close();
  try {
    new Persistence(path).close();
    assert.ok(log.mock.calls.some(call => String(call.arguments[0]) === "planner: schema v3: local_meal 2 → planned_meal 2; outbox dropped 1 (0 not saved)"));
    const db = new Persistence(path);
    assert.deepEqual(db.plannedRange("2030-01-01", "2030-02-01"), [
      { id: withMeal, mealId: library, name: "Dosa", date: "2030-01-07", time: "08:00" },
      { id: legacy, mealId: null, name: "Pongal", date: "2030-01-08", time: "19:30" },
    ]);
    db.close();
    assert.equal(log.mock.callCount(), 1, "a second start migrates nothing");
    assert.ok(existsSync(`${path}.pre-v3`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fresh database starts at v3 with no backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-fresh-")), path = join(dir, "new.sqlite");
  try {
    new Persistence(path).close();
    assert.ok(!existsSync(`${path}.pre-v3`));
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 3);
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback keeps multi-table changes atomic; future schemas fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-rollback-")), path = join(dir, "db.sqlite");
  try {
    const db = new Persistence(path), id = randomUUID();
    assert.throws(() => db.transaction(tx => {
      tx.libraryInsert({ id, name: "Rollback" });
      tx.plannedInsert({ id, mealId: id, name: "Rollback", date: "2030-01-01", time: "08:00" });
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(db.libraryGet(id), undefined);
    assert.equal(db.plannedGet(id), undefined);
    db.transaction(tx => tx.libraryInsert({ id, name: "Committed" }));
    db.close();
    const future = new DatabaseSync(path); future.exec("PRAGMA user_version=4"); future.close();
    assert.throws(() => new Persistence(path), /Unsupported database version 4/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT name FROM library WHERE id=?").get(id)!.name, "Committed");
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 4);
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
