import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { importLegacy } from "../scripts/import-legacy";
import { Store } from "../src/server/store";
import { FakeTodoist } from "../src/server/todoist";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "legacy-import-"));
  const source = join(directory, "backup.sqlite"),
    target = join(directory, "new.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE meal_library(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
    CREATE TABLE meal_slots(id TEXT PRIMARY KEY,name TEXT,time TEXT,position INTEGER,time_aliases TEXT,active INTEGER);
    CREATE TABLE kv(key TEXT,value TEXT);
    CREATE TABLE idempotent_actions(request_id TEXT,kind TEXT,state TEXT,create_attempted INTEGER);
    CREATE TABLE project_task_cache(task_key TEXT,remote_id TEXT);
    CREATE TABLE task_tombstones(remote_id TEXT);`);
  const first = randomUUID(),
    second = randomUUID();
  db.prepare("INSERT INTO meal_library VALUES(?,?,?)").run(first, "Dosa", 4);
  db.prepare("INSERT INTO meal_library VALUES(?,?,?)").run(second, "Rice", 0);
  db.exec(`INSERT INTO meal_slots VALUES('breakfast','Breakfast','08:30',2,'["08:00"]',1),('lunch','Lunch','13:00',0,'[]',1),('retired','Snack','16:00',3,'["15:00"]',0);
    INSERT INTO kv VALUES('theme_mode','dark');
    INSERT INTO idempotent_actions VALUES('acknowledged','create-meal','done',1);
    INSERT INTO project_task_cache VALUES('local:acknowledged','6XGgmFVcrG5RRjVr');`);
  db.close();
  return {
    directory,
    source,
    target,
    first,
    second,
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("legacy import preserves backup, library IDs/order/uniqueness, theme, aliases and inactive slot metadata; rerun refuses", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.source);
    const result = await importLegacy(f.source, f.target);
    assert.equal(result.activeSlots, 2);
    assert.equal(result.inactiveSlots, 1);
    assert.deepEqual(await readFile(f.source), before);
    const store = new Store(f.target),
      provider = new FakeTodoist(join(f.directory, "fake.sqlite"));
    try {
      const board = await store.board(provider);
      assert.deepEqual(
        board.library.map((meal) => meal.id),
        [f.second, f.first],
      );
      assert.deepEqual(
        board.slots.map((slot) => slot.name),
        ["Lunch", "Breakfast"],
      );
      assert.equal(board.settings.theme, "dark");
      assert.equal(board.settings.aliases["08:00"], board.slots[1].id);
      const duplicate = await store.addLibrary("  dOsA  ");
      assert.equal(duplicate.id, f.first);
      const metadata = board.settings as typeof board.settings & {
        legacyImport: {
          slots: { active: number }[];
          slotIds: Record<string, string>;
        };
      };
      assert.equal(
        metadata.legacyImport.slots.filter((slot) => slot.active === 0).length,
        1,
      );
      assert.equal(metadata.legacyImport.slotIds.breakfast, board.slots[1].id);
    } finally {
      await store.close();
      provider.close();
    }
    const targetBefore = await readFile(f.target);
    await assert.rejects(importLegacy(f.source, f.target), /nonexistent/);
    await assert.rejects(importLegacy(f.source, f.source), /distinct/);
    assert.deepEqual(await readFile(f.target), targetBefore);
    // Rollback is simply removal of the new artifact; original is byte-identical.
    await rm(f.target);
    assert.deepEqual(await readFile(f.source), before);
  } finally {
    await f.close();
  }
});
test("pending, processing, failed, uncertain, tombstones and local caches refuse cutover without creating target", async () => {
  for (const sql of [
    "INSERT INTO idempotent_actions VALUES('r','create-meal','pending',0)",
    "INSERT INTO idempotent_actions VALUES('r','create-meal','processing',1)",
    "INSERT INTO idempotent_actions VALUES('r','create-meal','failed',1)",
    "INSERT INTO task_tombstones VALUES('deleted')",
    "INSERT INTO project_task_cache VALUES('local:r',NULL)",
  ]) {
    const f = await fixture();
    try {
      const db = new DatabaseSync(f.source);
      db.exec(sql);
      db.close();
      const before = await readFile(f.source);
      await assert.rejects(
        importLegacy(f.source, f.target),
        /drain\/reconcile/,
      );
      assert.equal(existsSync(f.target), false);
      assert.deepEqual(await readFile(f.source), before);
    } finally {
      await f.close();
    }
  }
});
test("invalid data and transaction-stage failures leave no target; corrected backup can be rerun", async () => {
  const f = await fixture();
  try {
    let db = new DatabaseSync(f.source);
    db.exec("UPDATE kv SET value='invalid'");
    db.close();
    await assert.rejects(importLegacy(f.source, f.target), /theme/);
    assert.equal(existsSync(f.target), false);
    db = new DatabaseSync(f.source);
    db.exec(
      "UPDATE kv SET value='light'; INSERT INTO meal_library VALUES('f72d2fa1-2705-469c-826c-a13d1076e191','dosa',9)",
    );
    db.close();
    await assert.rejects(importLegacy(f.source, f.target), /duplicate/);
    assert.equal(existsSync(f.target), false);
    db = new DatabaseSync(f.source);
    db.exec("DELETE FROM meal_library WHERE name='dosa'");
    db.close();
    await importLegacy(f.source, f.target);
    assert.equal(existsSync(f.target), true);
  } finally {
    await f.close();
  }
});
