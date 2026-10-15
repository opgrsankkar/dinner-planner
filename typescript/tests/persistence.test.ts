import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/server/persistence";

// Synthetic schema captured from the former text-UUID contract, including its
// alphabetic Outbox column order and opaque metadata. No deployment data used.
test("adopt original schema without rewriting data, metadata or journal mode", () => {
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
  const snapshot = ["library", "slot", "setting", "session", "outbox", "_prisma_marker", "_prisma_ledger"].map(table => [table, old.prepare(`SELECT * FROM ${table}`).all()] as const);
  old.close();
  try {
    const db = new Persistence(path);
    assert.equal(db.libraryGet(mealId)?.name, "Old meal");
    assert.equal(db.outboxGet(requestId)?.attempted, "2");
    assert.equal(db.sessionGet(sessionId)?.csrf, "csrf");
    db.localMealInsert({ id: mealId, body: "{}" });
    db.localReceiptInsert({ id: requestId, body: "{}" });
    db.close();
    const check = new DatabaseSync(path);
    for (const [table, rows] of snapshot) assert.deepEqual(check.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.equal(check.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 1);
    check.close();
    const restarted = new Persistence(path);
    assert.equal(restarted.localReceiptGet(requestId)?.body, "{}");
    restarted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback keeps multi-table changes and receipts atomic; future schemas fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-rollback-")), path = join(dir, "db.sqlite");
  try {
    const db = new Persistence(path), id = randomUUID();
    assert.throws(() => db.transaction(tx => {
      tx.libraryInsert({ id, name: "Rollback" });
      tx.localMealInsert({ id, body: "{}" });
      tx.localReceiptInsert({ id, body: "{}" });
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(db.libraryGet(id), undefined);
    assert.equal(db.localMealGet(id), undefined);
    assert.equal(db.localReceiptGet(id), undefined);
    db.transaction(tx => tx.libraryInsert({ id, name: "Committed" }));
    db.close();
    const future = new DatabaseSync(path); future.exec("PRAGMA user_version=2"); future.close();
    assert.throws(() => new Persistence(path), /Unsupported database version 2/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT name FROM library WHERE id=?").get(id)!.name, "Committed");
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 2);
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
