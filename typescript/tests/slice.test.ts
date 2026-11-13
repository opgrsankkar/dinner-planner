import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store";
import { handle, type App } from "../src/server/app";
let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "planner-slice-"));
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/init-db.ts"],
    {
      env: {
        ...process.env,
        DATABASE_PATH: join(root, "template.sqlite"),
        PLANNER_DB: join(root, "template.sqlite"),
      },
      stdio: "pipe",
    },
  );
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(root, "case-"));
  const path = join(directory, "planner.sqlite");
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed();
  const board = await store.board();
  const input = {
    requestId: randomUUID(),
    mealId: board.library[0].id,
    slotId: board.slots[0].id,
    date: "2030-10-01",
  };
  const app: App = { store, origin: "http://localhost:3000", calendarToken: "" };
  let closed = false;
  return {
    store,
    input,
    path,
    app,
    slots: board.slots,
    async close() {
      if (closed) return;
      closed = true;
      await store.close();
    },
  };
}

test("a placement is saved at once, survives restart, and repeating it plans nothing new", async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 5 }, () => f.store.place(f.input)));
    const cards = (await f.store.board()).cards;
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, f.input.requestId);
    assert.equal(cards[0].mealId, f.input.mealId);
    assert.equal(cards[0].time, f.slots[0].time);
    await f.close();
    const store = new Store(f.path);
    try {
      await store.place(f.input);
      assert.deepEqual((await store.board()).cards.map((card) => card.id), [f.input.requestId]);
    } finally { await store.close(); }
  } finally {
    await f.close();
  }
});

test("invalid library/slot plans nothing; rollback actually works", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.place({ ...f.input, mealId: randomUUID() }), /no longer exists/);
    await assert.rejects(f.store.place({ ...f.input, slotId: randomUUID() }), /no longer exists/);
    await assert.rejects(f.store.place({ ...f.input, date: "2030-02-30" }), /Invalid day/);
    assert.equal((await f.store.board()).cards.length, 0);
    assert.throws(
      () => f.store.db.transaction((tx) => {
        tx.libraryInsert({ name: "Rolled back" });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.ok(!f.store.db.libraryAll().some((meal) => meal.name === "Rolled back"));
  } finally {
    await f.close();
  }
});

test("no login: hostile hosts and cross-site origins are rejected, same-origin writes work", async () => {
  const f = await fixture();
  const current = f.app;
  const request = (
    path: string,
    method = "GET",
    body: unknown = {},
    headers: Record<string, string> = {},
  ) =>
    new Request(`${current.origin}${path}`, {
      method,
      headers: {
        ...(method === "GET"
          ? {}
          : { origin: current.origin, "Content-Type": "application/json" }),
        ...headers,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await handle(request("/api/board"), current)).status, 200);
    assert.equal((await handle(new Request("http://evil.test/api/health"), current)).status, 403);
    assert.equal(
      (await handle(request("/api/plan", "POST", f.input, { origin: "http://evil.test" }), current)).status,
      403,
    );
    const noOrigin = new Request(`${current.origin}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f.input),
    });
    assert.equal((await handle(noOrigin, current)).status, 403);
    assert.equal((await f.store.board()).cards.length, 0);
    assert.equal((await handle(request("/api/plan", "POST", f.input), current)).status, 200);
    assert.equal((await f.store.board()).cards.length, 1);
    assert.equal((await handle(request("/api/login", "POST", { password: "x" }), current)).status, 404);
    assert.equal((await handle(request("/api/retry", "POST", { requestId: f.input.requestId }), current)).status, 404);
  } finally {
    await f.close();
  }
});

test("calendar feed needs the exact secret and lists planned meals", async () => {
  const f = await fixture();
  const token = "test-calendar-token-0123456789";
  const current: App = { ...f.app, calendarToken: token };
  try {
    const off = { ...current, calendarToken: "" };
    assert.equal((await handle(new Request(`${current.origin}/api/calendar/${token}.ics`), off)).status, 404);
    assert.equal((await handle(new Request(`${current.origin}/api/calendar/wrong-token-0123456789abc.ics`), current)).status, 404);
    // A meal tomorrow is inside the feed's window (two weeks back, 90 days on).
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await f.store.place({ ...f.input, date: tomorrow });
    await f.store.place({ ...f.input, requestId: randomUUID() });
    const board = await (await handle(new Request(`${current.origin}/api/board`), current)).json();
    assert.equal(board.calendarUrl, `${current.origin}/api/calendar/${token}.ics`);
    const feed = await handle(new Request(board.calendarUrl), current);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get("content-type")!, /text\/calendar/);
    const text = await feed.text();
    assert.match(text, /^BEGIN:VCALENDAR\r\n/);
    // 2030-10-01 is beyond the 90-day window; tomorrow's meal is listed.
    assert.deepEqual([...text.matchAll(/UID:([^@]+)@/g)].map((m) => m[1]), [f.input.requestId]);
  } finally {
    await f.close();
  }
});

test("move and delete are idempotent, survive restart, and a moved-away meal answers 404", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input);
    const move = { taskId: f.input.requestId, kind: "move" as const, slotId: f.slots[1].id, date: "2030-10-02" };
    await f.store.change(move);
    await f.store.change(move);
    await f.close();
    const store = new Store(f.path);
    try {
      const card = (await store.board()).cards[0];
      assert.deepEqual([card.date, card.time, card.slotId], ["2030-10-02", f.slots[1].time, f.slots[1].id]);
      await assert.rejects(store.change({ ...move, slotId: randomUUID() }), /Invalid destination/);
      await assert.rejects(store.change({ ...move, date: "tomorrow" }), /Invalid destination/);
      const deletion = { taskId: f.input.requestId, kind: "delete" as const };
      await store.change(deletion);
      await store.change(deletion);
      assert.equal((await store.board()).cards.length, 0);
      // A move of a meal that is gone is a client error the planner reports.
      const app: App = { ...f.app, store };
      const response = await handle(new Request(`${app.origin}/api/change`, {
        method: "POST",
        headers: { origin: app.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: randomUUID(), ...move }),
      }), app);
      assert.equal(response.status, 404);
      assert.match((await response.json()).error, /no longer exists/);
    } finally { await store.close(); }
  } finally {
    await f.close();
  }
});

test("completion follows the clock: past meals show eaten and can still be moved and deleted", async () => {
  const f = await fixture();
  try {
    const week = "2020-01-06";
    const past = { ...f.input, date: week };
    await f.store.place(past);
    let [card] = (await f.store.board(week)).cards;
    assert.equal(card.completed, true);
    // Without a week the board starts two weeks back, so old meals drop off.
    assert.equal((await f.store.board()).cards.length, 0);
    await f.store.change({ taskId: card.id, kind: "move", slotId: f.slots[2].id, date: "2020-01-07" });
    [card] = (await f.store.board(week)).cards;
    assert.deepEqual([card.date, card.completed], ["2020-01-07", true]);
    // Moving it into the future reopens it.
    await f.store.change({ taskId: card.id, kind: "move", slotId: f.slots[2].id, date: "2030-01-07" });
    assert.equal((await f.store.board("2030-01-07")).cards[0].completed, undefined);
    await f.store.change({ taskId: card.id, kind: "delete" });
    assert.equal((await f.store.board("2030-01-07")).cards.length, 0);
  } finally {
    await f.close();
  }
});

test("slot save atomically records aliases, order and revision; meals still to come follow their slot", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input);
    const past = { ...f.input, requestId: randomUUID(), date: "2020-01-06" };
    await f.store.place(past);
    const original = await f.store.board();
    const slots = original.slots
      .map((slot, index) => (index === 0 ? { ...slot, name: "Morning", time: "08:15" } : slot))
      .reverse();
    await f.store.saveSlots(slots, 0);
    assert.deepEqual((await f.store.board()).slots, [...slots].reverse());
    assert.deepEqual((await f.store.settings()).slotOrder, [...slots].reverse().map((slot) => slot.id));
    assert.equal((await f.store.settings()).aliases[original.slots[0].time], original.slots[0].id);
    const [future] = (await f.store.board()).cards;
    assert.deepEqual([future.time, future.slotId], ["08:15", original.slots[0].id]);
    // The eaten meal keeps its time and still finds its slot through the alias.
    const [eaten] = (await f.store.board("2020-01-06")).cards;
    assert.deepEqual([eaten.time, eaten.slotId], [original.slots[0].time, original.slots[0].id]);
    await assert.rejects(f.store.saveSlots(slots, 0), /changed elsewhere/);
    await assert.rejects(f.store.saveSlots(slots.map((slot) => ({ ...slot, time: "12:00" })), 1), /unique time/);
    // A removed library meal leaves its planned meals in place.
    await f.store.removeLibrary(f.input.mealId);
    const [kept] = (await f.store.board()).cards;
    assert.deepEqual([kept.id, kept.libraryMealId], [f.input.requestId, null]);
    await f.store.shuffle();
    const order = (await f.store.board()).library.map((meal) => meal.id);
    assert.deepEqual(order, (await f.store.settings()).libraryOrder);
    await f.store.saveTheme("dark");
    assert.equal((await f.store.board()).settings.theme, "dark");
  } finally {
    await f.close();
  }
});

test("two slots swapping times each keep their own meals", async () => {
  const f = await fixture();
  try {
    const [first, second] = f.slots;
    await f.store.place({ ...f.input, slotId: first.id });
    const other = { ...f.input, requestId: randomUUID(), slotId: second.id };
    await f.store.place(other);
    await f.store.saveSlots(
      f.slots.map((slot) =>
        slot.id === first.id ? { ...slot, time: second.time } : slot.id === second.id ? { ...slot, time: first.time } : slot,
      ),
      0,
    );
    const cards = (await f.store.board()).cards;
    const byId = new Map(cards.map((card) => [card.id, card]));
    assert.deepEqual([byId.get(f.input.requestId)!.time, byId.get(f.input.requestId)!.slotId], [second.time, first.id]);
    assert.deepEqual([byId.get(other.requestId)!.time, byId.get(other.requestId)!.slotId], [first.time, second.id]);
  } finally {
    await f.close();
  }
});

test("slot save follows prior aliases, leaves eaten meals and refuses removing an occupied slot", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input);
    await f.store.place({ ...f.input, requestId: randomUUID(), date: "2020-01-06" });
    // Both meals sit at 07:45, an old time of the first slot.
    for (const card of [...(await f.store.board()).cards, ...(await f.store.board("2020-01-06")).cards])
      f.store.db.plannedMove(card.id, card.date, "07:45");
    const board = await f.store.board();
    const setting = f.store.db.settingAll()[0];
    f.store.db.settingUpdate(setting.id, {
      value: JSON.stringify({ ...board.settings, aliases: { "07:45": f.input.slotId } }),
    });
    await assert.rejects(
      f.store.saveSlots(board.slots.filter((slot) => slot.id !== f.input.slotId), board.settings.revision),
      /Move or complete/,
    );
    await f.store.saveSlots(board.slots, board.settings.revision);
    assert.equal((await f.store.board()).cards[0].time, f.slots[0].time);
    assert.equal((await f.store.board("2020-01-06")).cards[0].time, "07:45");
  } finally {
    await f.close();
  }
});

test("library rename persists identity/order and leaves planned meals unchanged", async () => {
  const f = await fixture();
  try {
    await f.store.shuffle();
    const before = await f.store.board();
    await f.store.place(f.input);
    const planned = (await f.store.board()).cards.map((card) => [card.id, card.name]);
    await f.store.renameLibrary(f.input.mealId, "  Renamed reusable meal  ");
    const after = await f.store.board();
    assert.deepEqual(after.library.map(meal => meal.id), before.library.map(meal => meal.id));
    assert.equal(after.library.find(meal => meal.id === f.input.mealId)?.name, "Renamed reusable meal");
    assert.deepEqual(after.cards.map((card) => [card.id, card.name]), planned);
    // The card still resolves to its library meal by id.
    assert.equal(after.cards[0].libraryMealId, f.input.mealId);
    const other = after.library.find(meal => meal.id !== f.input.mealId)!;
    await assert.rejects(f.store.renameLibrary(f.input.mealId, other.name.toUpperCase()), /already exists/);
    for (const name of ["   ", "x".repeat(121)]) await assert.rejects(f.store.renameLibrary(f.input.mealId, name), /1–120/);
    await assert.rejects(f.store.renameLibrary(randomUUID(), "Missing meal"), /not found/);
    await assert.rejects(f.store.renameLibrary("bad-id", "Name"), /Invalid meal ID/);
    const reopened = new Store(f.path);
    try { assert.equal((await reopened.board()).library.find(meal => meal.id === f.input.mealId)?.name, "Renamed reusable meal"); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("rename API requires same origin and validates fields", async () => {
  const f = await fixture();
  const app = f.app;
  const request = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(app.origin + path, {
    method: "POST", headers: { origin: app.origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const body = { mealId: f.input.mealId, name: "API renamed meal" };
  try {
    assert.equal((await handle(request("/api/library/rename", body, { origin: "http://evil.test" }), app)).status, 403);
    assert.equal((await handle(request("/api/library/rename", { ...body, name: 3 }), app)).status, 400);
    assert.equal((await handle(request("/api/library/rename", body), app)).status, 202);
    assert.equal((await f.store.board()).library.find(meal => meal.id === body.mealId)?.name, body.name);
  } finally { await f.close(); }
});

test("alternate meal names save, stay unique, find the meal and go with it", async () => {
  const f = await fixture();
  try {
    const [meal, other] = (await f.store.board()).library;
    await f.store.renameLibrary(meal.id, meal.name, [" Thayir  sadam ", "thayir sadam", meal.name.toUpperCase(), "Mosaru anna"]);
    let library = (await f.store.board()).library;
    assert.deepEqual(library.find(item => item.id === meal.id)?.aliases, ["Thayir sadam", "Mosaru anna"]);
    // A rename without aliases keeps them; adding an alias returns its meal.
    await f.store.renameLibrary(meal.id, "Curd rice");
    assert.deepEqual((await f.store.addLibrary("THAYIR SADAM")).id, meal.id);
    library = (await f.store.board()).library;
    assert.equal(library.length, 3);
    assert.deepEqual(library.find(item => item.id === meal.id), { id: meal.id, name: "Curd rice", aliases: ["Thayir sadam", "Mosaru anna"], hasRecipe: false, variantCount: 0 });
    await assert.rejects(f.store.renameLibrary(other.id, other.name, ["mosaru anna"]), /already a name for Curd rice/);
    await assert.rejects(f.store.renameLibrary(other.id, "Thayir sadam"), /already a name for Curd rice/);
    await assert.rejects(f.store.renameLibrary(other.id, other.name, ["Curd rice"]), /already a name for Curd rice/);
    await assert.rejects(f.store.renameLibrary(meal.id, "Curd rice", ["x".repeat(121)]), /Alternate names must be 1–120/);
    await assert.rejects(f.store.renameLibrary(meal.id, "Curd rice", Array.from({ length: 11 }, (_, i) => `Name ${i}`)), /at most 10/);
    await f.store.renameLibrary(meal.id, "Curd rice", []);
    assert.deepEqual((await f.store.board()).library.find(item => item.id === meal.id)?.aliases, []);
    await f.store.renameLibrary(meal.id, "Curd rice", ["Thayir sadam"]);
    await f.store.removeLibrary(meal.id);
    assert.equal(f.store.db.libraryAliasAll().length, 0);
    assert.notEqual((await f.store.addLibrary("Thayir sadam")).id, meal.id);
  } finally { await f.close(); }
});

test("rename API accepts alternate names and rejects malformed ones", async () => {
  const f = await fixture();
  const app = f.app;
  const request = (body: unknown) => new Request(app.origin + "/api/library/rename", {
    method: "POST", headers: { origin: app.origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const body = { mealId: f.input.mealId, name: "Curd rice" };
  try {
    assert.equal((await handle(request({ ...body, aliases: "Thayir sadam" }), app)).status, 400);
    assert.equal((await handle(request({ ...body, aliases: [3] }), app)).status, 400);
    assert.equal((await handle(request({ ...body, aliases: ["Thayir sadam"] }), app)).status, 202);
    assert.deepEqual((await f.store.board()).library.find(meal => meal.id === body.mealId)?.aliases, ["Thayir sadam"]);
  } finally { await f.close(); }
});
