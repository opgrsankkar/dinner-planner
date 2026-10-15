import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function startup(path: string) {
  const result = spawnSync(process.execPath, ["scripts/serve.mjs"], {
    env: {
      ...process.env, DATABASE_PATH: path, TODOIST_MODE: "local",
      APP_PASSWORD: "synthetic-startup-test", PORT: "0",
    }, encoding: "utf8", timeout: 10000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null, "Startup must fail rather than start listening");
  assert.doesNotMatch(result.stdout, /HTTP server ready/);
  return result.stderr;
}

test("production startup refuses future schema before listening and leaves it unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "planner-startup-")), path = join(directory, "future.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=2; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('unchanged')");
    db.close();
    assert.match(startup(path), /Unsupported database version 2/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.equal(check.prepare("SELECT value FROM sentinel").get()!.value, "unchanged");
    check.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production startup refuses an inaccessible database path before listening", () => {
  const directory = mkdtempSync(join(tmpdir(), "planner-startup-"));
  try {
    const blocked = join(directory, "not-a-directory");
    writeFileSync(blocked, "synthetic path blocker");
    assert.match(startup(join(blocked, "planner.sqlite")), /EEXIST|ENOTDIR/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production startup refuses a read-only database before listening", { skip: process.getuid?.() === 0 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "planner-startup-")), path = join(directory, "readonly.sqlite");
  try {
    new DatabaseSync(path).close();
    chmodSync(path, 0o444);
    assert.match(startup(path), /readonly|read-only|SQLITE_READONLY/i);
  } finally { chmodSync(path, 0o600); rmSync(directory, { recursive: true, force: true }); }
});
