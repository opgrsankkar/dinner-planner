import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, Worker } from "../src/server/store";
import { LocalPlan } from "../src/server/local-plan";
import { FakeTodoist } from "../src/server/todoist";
import { DatabaseSync } from "node:sqlite";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "planner-local-"));
  execFileSync(process.execPath, ["--import", "tsx", "scripts/init-db.ts"], {
    env: { ...process.env, DATABASE_PATH: join(root, "template.sqlite") }, stdio: "pipe",
  });
});
after(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const path = join(root, `${randomUUID()}.sqlite`);
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed(false);
  const meal = await store.addLibrary("Local dinner");
  const provider = new LocalPlan(store);
  const board = await store.board(provider);
  const input = { requestId: randomUUID(), mealId: meal.id, slotId: board.slots[0].id, date: "2030-10-12" };
  return { path, store, provider, input, board, worker: new Worker(store, provider) };
}

test("local plans persist beyond overlays and restart; replay cannot duplicate or resurrect a deleted meal", async () => {
  const f = await fixture();
  let store = f.store;
  try {
    await store.place(f.input, f.board.projectId);
    assert.equal((await store.board(f.provider)).cards[0].state, "pending");
    await f.worker.tick();
    const saved = (await store.board(f.provider)).cards[0];
    assert.equal(saved.state, "saved");
    assert.ok(saved.confirmedAt > 0);
    await store.db.outboxUpdate(f.input.requestId, { confirmedAt: "1" });
    await store.close();
    store = new Store(f.path);
    const provider = new LocalPlan(store), worker = new Worker(store, provider);
    const board = await store.board(provider);
    assert.equal(board.integrationError, "");
    assert.equal(board.cards[0].id, saved.id);
    await store.place(f.input, board.projectId);
    const move = { requestId: randomUUID(), taskId: saved.id, kind: "move" as const, slotId: board.slots[1].id, date: "2030-10-13" };
    await store.change(move, provider);
    await worker.tick();
    await store.change(move, provider);
    assert.equal((await provider.list(board.projectId)).length, 1);
    assert.equal((await store.board(provider)).cards[0].date, move.date);
    await assert.rejects(store.change({ ...move, date: "2030-10-14" }, provider), /another operation/);
    await store.removeLibrary(f.input.mealId);
    assert.equal((await provider.list(board.projectId)).length, 1);
    const deletion = { requestId: randomUUID(), taskId: saved.id, kind: "delete" as const };
    await store.change(deletion, provider);
    await store.close();
    store = new Store(f.path);
    const restarted = new LocalPlan(store);
    await new Worker(store, restarted).tick();
    await restarted.delete(saved.id, board.projectId, deletion.requestId);
    // Replaying a committed create after its deletion returns a receipt only.
    await restarted.create({ ...f.input, name: saved.name, projectId: board.projectId, time: saved.time }, f.input.requestId);
    assert.equal((await store.board(restarted)).cards.length, 0);
    assert.ok((await store.board(restarted)).receivedRequests.includes(deletion.requestId));
    await assert.rejects(restarted.delete(saved.id, "foreign-project", randomUUID()), /ownership/);
  } finally { await store.close(); }
});

test("local slot time changes migrate durable meals and retain settings validation", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.board.projectId);
    await f.worker.tick();
    await assert.rejects(f.store.saveSlots(f.board.slots.slice(1), 0, f.provider), /Move or complete/);
    const slots = f.board.slots.map((slot, index) => index === 0 ? { ...slot, time: "08:15" } : slot);
    await f.store.saveSlots(slots, 0, f.provider);
    await assert.rejects(f.store.saveSlots(slots, 1, f.provider), /pending meals/);
    await f.worker.tick();
    const board = await f.store.board(f.provider);
    assert.equal(board.cards[0].time, "08:15");
    assert.equal(board.cards[0].slotId, f.input.slotId);
    await assert.rejects(f.store.saveSlots(slots, 0, f.provider), /changed elsewhere/);
  } finally { await f.store.close(); }
});

test("local provider receipts survive a lost acknowledgement and worker retry", async () => {
  const f = await fixture();
  try {
    const create = f.provider.create.bind(f.provider);
    let fail = true;
    f.provider.create = async (input, requestId) => {
      const task = await create(input, requestId);
      if (fail) { fail = false; throw new Error("Lost local acknowledgement"); }
      return task;
    };
    await f.store.place(f.input, f.board.projectId);
    await f.worker.tick();
    assert.equal((await f.store.board(f.provider)).cards[0].state, "pending");
    await f.store.retry(f.input.requestId, f.provider);
    await f.worker.tick();
    assert.equal((await f.store.board(f.provider)).cards[0].state, "saved");
    assert.equal((await f.provider.list(f.board.projectId)).length, 1);
  } finally { await f.store.close(); }
});

test("existing Todoist databases remain usable without the new local tables", async () => {
  const f = await fixture();
  await f.store.close();
  const db = new DatabaseSync(f.path);
  db.exec("DROP TABLE local_meal; DROP TABLE local_receipt");
  db.close();
  const store = new Store(f.path), provider = new FakeTodoist(join(root, `${randomUUID()}.sqlite`));
  provider.delayMs = 0;
  try {
    await store.seed(false);
    const board = await store.board(provider);
    await store.place(f.input, board.projectId);
    await new Worker(store, provider).tick();
    assert.equal((await store.board(provider)).cards[0].state, "saved");
  } finally { await store.close(); provider.close(); }
});

test("local completed meals can be moved (staying completed) and deleted", async () => {
  const f = await fixture();
  try {
    // 2020 is in the past, so the placement is created completed.
    await f.store.place({ ...f.input, date: "2020-10-12" }, f.board.projectId);
    await f.worker.tick();
    const week = { week: "2020-10-12" };
    const [done] = await f.provider.list(f.board.projectId, week);
    assert.equal(done.completed, true);
    const move = { requestId: randomUUID(), taskId: done.id, kind: "move" as const, slotId: f.board.slots[1].id, date: "2020-10-13" };
    await f.store.change(move, f.provider);
    await f.worker.tick();
    const [moved] = await f.provider.list(f.board.projectId, week);
    assert.equal(moved.date, move.date);
    assert.equal(moved.time, f.board.slots[1].time);
    assert.equal(moved.completed, true, "moved meal is completed again");
    await f.store.change({ requestId: randomUUID(), taskId: done.id, kind: "delete" }, f.provider);
    await f.worker.tick();
    assert.equal((await f.provider.list(f.board.projectId, week)).length, 0);
  } finally {
    await f.store.close();
  }
});

test("local completion follows the clock and listings are limited to the requested week", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.board.projectId);
    await f.worker.tick();
    const [future] = await f.provider.list(f.board.projectId);
    assert.equal(future.completed, undefined);
    // Moving a planned meal into the past marks it eaten; moving it back reopens it.
    const past = { requestId: randomUUID(), taskId: future.id, kind: "move" as const, slotId: f.board.slots[0].id, date: "2020-10-14" };
    await f.store.change(past, f.provider);
    await f.worker.tick();
    assert.equal((await f.provider.list(f.board.projectId)).length, 0, "old meals are outside the default window");
    const [eaten] = await f.provider.list(f.board.projectId, { week: "2020-10-12" });
    assert.equal(eaten.completed, true);
    const back = { requestId: randomUUID(), taskId: future.id, kind: "move" as const, slotId: f.board.slots[0].id, date: "2030-10-15" };
    await f.store.change(back, f.provider);
    await f.worker.tick();
    const [reopened] = await f.provider.list(f.board.projectId, { week: "2030-10-14" });
    assert.equal(reopened.date, "2030-10-15");
    assert.equal(reopened.completed, undefined);
    assert.equal((await f.provider.list(f.board.projectId, { week: "2030-10-07" })).length, 0);
  } finally {
    await f.store.close();
  }
});

test("prune drops week-old acknowledgements and orphaned receipts but keeps pending work", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.board.projectId);
    await f.worker.tick();
    const pending = { ...f.input, requestId: randomUUID(), date: "2030-10-13" };
    await f.store.place(pending, f.board.projectId);
    await f.store.db.outboxUpdate(f.input.requestId, { confirmedAt: String(Date.now() - 8 * 86400000) });
    await f.store.prune();
    assert.equal(f.store.db.outboxGet(f.input.requestId), undefined);
    assert.equal(f.store.db.localReceiptGet(f.input.requestId), undefined);
    assert.equal(f.store.db.outboxGet(pending.requestId)?.state, "pending");
    assert.equal((await f.provider.list(f.board.projectId)).length, 1, "the meal itself stays");
  } finally {
    await f.store.close();
  }
});
