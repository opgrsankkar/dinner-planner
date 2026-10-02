import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { handle } from "../src/server/app";
import type { App } from "../src/server/app";
import { Store } from "../src/server/store";
import { FakeTodoist } from "../src/server/todoist";

test("authenticated rename trims and validates names, preserves library identity/order and existing planned meals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "library-rename-"));
  const template = join(directory, "template.sqlite");
  const database = join(directory, "planner.sqlite");
  execFileSync(process.execPath, ["node_modules/prisma/dist/prisma.js", "db", "init"], {
    env: { ...process.env, DATABASE_PATH: template, PLANNER_DB: template },
    stdio: "pipe",
  });
  await cp(template, database);
  const store = new Store(database);
  const todoist = new FakeTodoist(join(directory, "todoist.sqlite"));
  await store.seed(true);
  try {
    const before = await store.board(todoist);
    const meal = before.library[0]!;
    const slot = before.slots[0]!;
    const project = await todoist.mealsProject();
    await store.place({
      requestId: "66666666-6666-4666-8666-666666666666",
      mealId: meal.id,
      slotId: slot.id,
      date: "2026-10-05",
    }, project.id);
    const current: Parameters<typeof handle>[1] = {
      store,
      todoist,
      worker: {} as App["worker"],
      password: "synthetic-password",
      origin: "http://planner.test",
      loginFailures: { count: 0, resetAt: 0 },
    };
    const login = await handle(new Request("http://planner.test/api/login", {
      method: "POST", headers: { Origin: "http://planner.test" },
      body: JSON.stringify({ password: "synthetic-password" }),
    }), current);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const boardResponse = await handle(new Request("http://planner.test/api/board", {
      headers: { Cookie: cookie },
    }), current);
    const board = await boardResponse.json() as { csrf: string; library: { id: string; name: string }[]; cards: { name: string }[] };
    const postRename = (name: string, csrf = board.csrf) => handle(new Request("http://planner.test/api/library/rename", {
      method: "POST", headers: { Cookie: cookie, Origin: "http://planner.test", "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ mealId: meal.id, name }),
    }), current);

    assert.equal((await handle(new Request("http://planner.test/api/library/rename", {
      method: "POST", headers: { Cookie: cookie, Origin: "http://planner.test", "Content-Type": "application/json" },
      body: JSON.stringify({ mealId: meal.id, name: "Renamed" }),
    }), current)).status, 403);
    assert.equal((await postRename("Renamed", "wrong-token")).status, 403);
    assert.equal((await postRename("   ")).status, 400);
    assert.equal((await postRename("x".repeat(121))).status, 400);
    const duplicateName = before.library[1]!.name.toUpperCase();
    assert.equal((await postRename(duplicateName)).status, 400);
    assert.equal((await postRename("  New   family meal  ")).status, 202);
    const after = await store.board(todoist);
    assert.deepEqual(after.library.map(({ id }) => id), before.library.map(({ id }) => id));
    assert.equal(after.library.find(({ id }) => id === meal.id)?.name, "New family meal");
    assert.equal(after.cards[0]?.name, meal.name);
    await store.close();
    const reopened = new Store(database);
    try {
      assert.equal((await reopened.board(todoist)).library.find(({ id }) => id === meal.id)?.name, "New family meal");
    } finally {
      await reopened.close();
    }
  } finally {
    todoist.close();
    // The store may already have been closed before the persistence assertion.
    try { await store.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
