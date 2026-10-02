import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, Worker } from "../src/server/store";
import { FakeTodoist } from "../src/server/todoist";
import { handle, type App } from "../src/server/app";
let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "planner-slice-"));
  execFileSync(
    process.execPath,
    ["node_modules/prisma/dist/prisma.js", "db", "init"],
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
  const providerPath = join(directory, "provider.sqlite");
  const provider = new FakeTodoist(providerPath);
  provider.delayMs = 0;
  const worker = new Worker(store, provider);
  const board = await store.board(provider);
  const input = {
    requestId: randomUUID(),
    mealId: board.library[0].id,
    slotId: board.slots[0].id,
    date: "2026-10-01",
  };
  const project = await provider.mealsProject();
  let closed = false;
  return {
    store,
    provider,
    worker,
    input,
    project,
    path,
    providerPath,
    async close() {
      if (closed) return;
      closed = true;
      await worker.stop();
      await store.close();
      provider.close();
    },
  };
}
test("placement transaction survives reload and both application/provider restart", async () => {
  const f = await fixture();
  await f.store.place(f.input, f.project.id);
  const pending = await f.store.board(f.provider);
  assert.equal(pending.cards[0].state, "pending");
  assert.equal((await f.provider.list(f.project.id)).length, 0);
  await f.close();
  const store = new Store(f.path);
  const provider = new FakeTodoist(f.providerPath);
  provider.delayMs = 0;
  const worker = new Worker(store, provider);
  try {
    assert.equal(
      (await store.board(provider)).cards[0].requestId,
      f.input.requestId,
    );
    await worker.tick();
    const saved = (await store.board(provider)).cards[0];
    assert.equal(saved.state, "saved");
    assert.equal(saved.requestId, f.input.requestId);
    assert.ok(saved.confirmedAt > 0);
    assert.equal((await provider.list(f.project.id)).length, 1);
  } finally {
    await worker.stop();
    await store.close();
    provider.close();
  }
});
test("lost create response reconciles marker after restart without another create", async () => {
  const f = await fixture();
  await f.store.place(f.input, f.project.id);
  f.provider.loseResponse = 1;
  await f.worker.tick();
  assert.equal(f.provider.createCalls, 1);
  const pending = (await f.store.board(f.provider)).cards[0];
  assert.equal(pending.state, "pending");
  assert.match(pending.error, /response lost/);
  assert.equal((await f.provider.list(f.project.id)).length, 1);
  await f.close();
  const store = new Store(f.path);
  const provider = new FakeTodoist(f.providerPath);
  const worker = new Worker(store, provider);
  try {
    await new Promise((resolve) => setTimeout(resolve, 550));
    await worker.tick();
    assert.equal(provider.createCalls, 0);
    assert.equal((await provider.list(f.project.id)).length, 1);
    assert.equal((await store.board(provider)).cards[0].state, "saved");
  } finally {
    await worker.stop();
    await store.close();
    provider.close();
  }
});
test("failed provider response retains intent and retries with original request ID", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    f.provider.failBefore = 1;
    await f.worker.tick();
    assert.equal((await f.provider.list(f.project.id)).length, 0);
    assert.equal((await f.store.board(f.provider)).cards[0].state, "pending");
    await new Promise((resolve) => setTimeout(resolve, 550));
    await f.worker.tick();
    const remote = await f.provider.list(f.project.id);
    assert.equal(remote.length, 1);
    assert.equal(remote[0].requestId, f.input.requestId);
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    assert.equal((await f.provider.list(f.project.id)).length, 1);
  } finally {
    await f.close();
  }
});
test("retry reuses request ID when uncertain create marker is temporarily invisible", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    const list = f.provider.list.bind(f.provider);
    const create = f.provider.create.bind(f.provider);
    const requests: string[] = [];
    f.provider.list = async () => [];
    f.provider.create = async (input, requestId) => {
      requests.push(requestId);
      return create(input, requestId);
    };
    f.provider.loseResponse = 1;
    await f.worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 550));
    await f.worker.tick();
    assert.deepEqual(requests, [f.input.requestId, f.input.requestId]);
    assert.equal((await list(f.project.id)).length, 1);
    assert.equal((await f.store.db.orm.Outbox.all())[0].state, "saved");
  } finally {
    await f.close();
  }
});

test("concurrent repeated placement is idempotent and altered reuse is rejected", async () => {
  const f = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 5 }, () => f.store.place(f.input, f.project.id)),
    );
    assert.equal((await f.store.db.orm.Outbox.all()).length, 1);
    await assert.rejects(
      f.store.place({ ...f.input, date: "2026-10-02" }, f.project.id),
      /another placement/,
    );
    await Promise.all([f.worker.tick(), f.worker.tick()]);
    assert.equal(f.provider.createCalls, 1);
  } finally {
    await f.close();
  }
});
test("invalid library/slot causes no intent; rollback actually works", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.store.place({ ...f.input, mealId: randomUUID() }, f.project.id),
      /no longer exists/,
    );
    assert.equal((await f.store.db.orm.Outbox.all()).length, 0);
    await assert.rejects(
      f.store.db.transaction(async (tx) => {
        await tx.orm.Library.create({ name: "Rolled back" });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.ok(
      !(await f.store.db.orm.Library.all()).some(
        (meal) => meal.name === "Rolled back",
      ),
    );
  } finally {
    await f.close();
  }
});
test("changed Meals project ownership prevents create; bad acknowledgement remains pending", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    f.provider.mealsProject = async () => ({
      id: "other-project",
      name: "Meals",
    });
    await f.worker.tick();
    assert.equal(f.provider.createCalls, 0);
    assert.match((await f.store.db.orm.Outbox.all())[0].error, /ownership/);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    await g.store.place(g.input, g.project.id);
    const create = g.provider.create.bind(g.provider);
    g.provider.create = async (input, requestId) => ({
      ...(await create(input, requestId)),
      projectId: "other-project",
    });
    await g.worker.tick();
    assert.equal((await g.store.db.orm.Outbox.all())[0].state, "pending");
    assert.match((await g.store.db.orm.Outbox.all())[0].error, /did not match/);
  } finally {
    await g.close();
  }
});
test("saved write overlay is bounded, then provider is authoritative", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    f.provider.list = async () => [];
    assert.equal((await f.store.board(f.provider)).cards.length, 1);
    const row = (await f.store.db.orm.Outbox.all())[0];
    await f.store.db.orm.Outbox.where({ id: row.id }).update({
      confirmedAt: String(Date.now() - 120001),
    });
    assert.equal((await f.store.board(f.provider)).cards.length, 0);
  } finally {
    await f.close();
  }
});
test("login/session/logout, hostile hosts/origins, CSRF, expiry and wrong password", async () => {
  const f = await fixture();
  const current: App = {
    store: f.store,
    todoist: f.provider,
    worker: f.worker,
    password: randomUUID(),
    origin: "http://localhost:3000",
    loginFailures: { count: 0, resetAt: 0 },
  };
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
    assert.equal((await handle(request("/api/board"), current)).status, 401);
    assert.equal(
      (await handle(new Request("http://evil.test/api/health"), current))
        .status,
      403,
    );
    assert.equal(
      (
        await handle(
          request(
            "/api/login",
            "POST",
            { password: current.password },
            { origin: "http://evil.test" },
          ),
          current,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handle(
          request("/api/login", "POST", { password: "incorrect-test-input" }),
          current,
        )
      ).status,
      401,
    );
    const login = await handle(
      request("/api/login", "POST", { password: current.password }),
      current,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const board = await (
      await handle(request("/api/board", "GET", {}, { cookie }), current)
    ).json();
    assert.ok(board.csrf);
    assert.equal(
      (await handle(request("/api/plan", "POST", f.input, { cookie }), current))
        .status,
      403,
    );
    const mutationHeaders = { cookie, "x-csrf-token": board.csrf };
    assert.equal(
      (
        await handle(
          request("/api/plan", "POST", f.input, mutationHeaders),
          current,
        )
      ).status,
      202,
    );
    assert.equal(
      (
        await handle(
          request("/api/logout", "POST", {}, mutationHeaders),
          current,
        )
      ).status,
      200,
    );
    assert.equal(
      (await handle(request("/api/board", "GET", {}, { cookie }), current))
        .status,
      401,
    );
    const session = await f.store.login();
    await f.store.db.orm.Session.where({ id: session.id }).update({
      expiresAt: "0",
    });
    assert.equal(await f.store.session(session.id), null);
  } finally {
    await f.close();
  }
});

test("move and delete survive restart, retry stable IDs, and delete never reads afterward", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    const task = (await f.provider.list(f.project.id))[0];
    const slots = (await f.store.board(f.provider)).slots;
    const move = {
      requestId: randomUUID(),
      taskId: task.id,
      kind: "move" as const,
      slotId: slots[1].id,
      date: "2026-10-02",
    };
    await f.store.change(move, f.provider);
    f.provider.loseResponse = 1;
    await f.worker.tick();
    assert.equal((await f.store.board(f.provider)).cards[0].state, "pending");
    await f.store.retry(move.requestId, f.provider);
    await f.worker.tick();
    await f.store.change(move, f.provider);
    assert.equal((await f.provider.list(f.project.id))[0].time, slots[1].time);
    await assert.rejects(
      f.store.change({ ...move, date: "2026-10-03" }, f.provider),
      /another operation/,
    );
    const deletion = {
      requestId: randomUUID(),
      taskId: task.id,
      kind: "delete" as const,
    };
    await f.store.change(deletion, f.provider);
    await f.close();
    const store = new Store(f.path),
      provider = new FakeTodoist(f.providerPath);
    provider.delayMs = 0;
    const worker = new Worker(store, provider);
    try {
      provider.list = async () => {
        throw new Error("DELETE acknowledgement must not trigger GET");
      };
      await worker.tick();
      const op = await store.db.orm.Outbox.where({
        id: deletion.requestId as `${string}-${string}-${string}-${string}-${string}`,
      }).first();
      assert.equal(op?.state, "saved");
      // Repeated delete, including an absent task, is acknowledged idempotently.
      await provider.delete(task.id, f.project.id, deletion.requestId);
      await provider.delete(task.id, f.project.id, randomUUID());
    } finally {
      await worker.stop();
      await store.close();
      provider.close();
    }
  } finally {
    await f.close();
  }
});

test("slot save atomically records time intent, aliases, order and revision; library removal preserves planned task", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    const original = await f.store.board(f.provider);
    const slots = original.slots
      .map((slot, index) =>
        index === 0 ? { ...slot, name: "Morning", time: "08:15" } : slot,
      )
      .reverse();
    await f.store.saveSlots(slots, 0, f.provider);
    assert.deepEqual((await f.store.board(f.provider)).slots, [...slots].reverse());
    assert.deepEqual((await f.store.settings()).slotOrder, [...slots].reverse().map(slot => slot.id));
    assert.equal(
      (await f.store.settings()).aliases[original.slots[0].time],
      original.slots[0].id,
    );
    assert.equal(
      (await f.provider.list(f.project.id))[0].time,
      original.slots[0].time,
    );
    f.provider.failBefore = 1;
    await f.worker.tick();
    const pending = (await f.store.board(f.provider)).cards[0];
    await assert.rejects(
      f.store.saveSlots(slots, 1, f.provider),
      /pending meals/,
    );
    assert.equal(pending.time, "08:15");
    assert.ok(pending.error);
    await f.store.retry(pending.requestId, f.provider);
    await f.worker.tick();
    assert.equal((await f.provider.list(f.project.id))[0].time, "08:15");
    await assert.rejects(
      f.store.saveSlots(slots, 0, f.provider),
      /changed elsewhere/,
    );
    await assert.rejects(
      f.store.saveSlots(
        slots.map((slot) => ({ ...slot, time: "12:00" })),
        1,
        f.provider,
      ),
      /unique time/,
    );
    await f.store.removeLibrary(f.input.mealId);
    assert.equal((await f.provider.list(f.project.id)).length, 1);
    await f.store.shuffle();
    const order = (await f.store.board(f.provider)).library.map(
      (meal) => meal.id,
    );
    assert.deepEqual(order, (await f.store.settings()).libraryOrder);
    await f.store.saveTheme("dark");
    assert.equal((await f.store.board(f.provider)).settings.theme, "dark");
  } finally {
    await f.close();
  }
});

test("move/delete ownership, pending exclusion, and missing delete acknowledgement", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    const task = (await f.provider.list(f.project.id))[0];
    await assert.rejects(
      f.store.change(
        { requestId: randomUUID(), taskId: randomUUID(), kind: "delete" },
        f.provider,
      ),
      /belong/,
    );
    const requestId = randomUUID();
    await f.store.change(
      { requestId, taskId: task.id, kind: "delete" },
      f.provider,
    );
    await assert.rejects(
      f.store.change(
        { requestId: randomUUID(), taskId: task.id, kind: "delete" },
        f.provider,
      ),
      /pending/,
    );
    f.provider.mealsProject = async () => ({ id: "other", name: "Meals" });
    await f.worker.tick();
    assert.equal(f.provider.deleteCalls, 0);
    await assert.rejects(f.store.retry(requestId, f.provider), /belong/);
    f.provider.mealsProject = async () => f.project;
    await f.provider.delete(task.id, f.project.id, randomUUID());
    await f.store.retry(requestId, f.provider);
    await f.worker.tick();
    assert.equal((await f.store.board(f.provider)).cards.length, 0);
  } finally {
    await f.close();
  }
});

test("additive initialization upgrades a synthetic first-slice database without losing outbox or library", async () => {
  const f = await fixture();
  await f.store.place(f.input, f.project.id);
  await f.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.path);
  db.exec("DROP TABLE setting");
  db.close();
  execFileSync(
    process.execPath,
    ["node_modules/prisma/dist/prisma.js", "db", "init"],
    {
      env: { ...process.env, DATABASE_PATH: f.path, PLANNER_DB: f.path },
      stdio: "pipe",
    },
  );
  const store = new Store(f.path),
    provider = new FakeTodoist(f.providerPath);
  provider.delayMs = 0;
  const worker = new Worker(store, provider);
  try {
    await store.seed();
    assert.equal((await store.board(provider)).library.length, 3);
    assert.equal(
      (await store.board(provider)).cards[0].requestId,
      f.input.requestId,
    );
    await worker.tick();
    assert.equal((await store.board(provider)).cards[0].state, "saved");
  } finally {
    await worker.stop();
    await store.close();
    provider.close();
  }
});

test("lost delete response retries the same durable receipt; stale listing cannot resurrect deleted card", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    const task = (await f.provider.list(f.project.id))[0];
    const requestId = randomUUID();
    await f.store.change(
      { requestId, taskId: task.id, kind: "delete" },
      f.provider,
    );
    f.provider.loseResponse = 1;
    await f.worker.tick();
    assert.equal((await f.store.board(f.provider)).cards[0].deleting, true);
    await f.store.retry(requestId, f.provider);
    await f.worker.tick();
    f.provider.list = async () => [task];
    assert.equal((await f.store.board(f.provider)).cards.length, 0);
    assert.ok(
      (await f.store.board(f.provider)).receivedRequests.includes(requestId),
    );
    assert.equal(f.provider.deleteCalls, 2);
  } finally {
    await f.close();
  }
});

test("move acknowledgement mismatch stays pending and remote task ownership is enforced", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    const board = await f.store.board(f.provider),
      task = board.cards[0];
    const requestId = randomUUID();
    await f.store.change(
      {
        requestId,
        taskId: task.id,
        kind: "move",
        slotId: board.slots[1].id,
        date: "2026-10-02",
      },
      f.provider,
    );
    const move = f.provider.move.bind(f.provider);
    f.provider.move = async (input, id) => ({
      ...(await move(input, id)),
      projectId: "other-project",
    });
    await f.worker.tick();
    assert.match(
      (await f.store.board(f.provider)).cards[0].error,
      /did not match move/,
    );
    await assert.rejects(
      f.provider.delete(task.id, "other-project", randomUUID()),
      /ownership/,
    );
    await assert.rejects(
      move(
        {
          mealId: "",
          name: task.name,
          date: task.date,
          time: task.time,
          projectId: "other-project",
          slotId: "",
          taskId: task.id,
        },
        randomUUID(),
      ),
      /ownership/,
    );
  } finally {
    await f.close();
  }
});

test("real adapter uncertain create survives worker restart and invisible markers without replay", async () => {
  const { TodoistApi } = await import("../src/server/todoist-api");
  const f = await fixture();
  const projectId = "6XGgm6PHrGgMpCFX";
  let visible = false,
    creates = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("projects"))
      return Response.json({
        results: [{ id: projectId, name: "Meals" }],
        next_cursor: null,
      });
    if (path.endsWith("by_due_date"))
      return Response.json({ items: [], next_cursor: null });
    if (init?.method === "POST") {
      creates++;
      throw new Error("Lost response after server created task");
    }
    return Response.json({
      results: visible
        ? [
            {
              id: "6XGgmFVcrG5RRjVr",
              project_id: projectId,
              content: "Idli & sambar",
              description: `meal-planner-request-id: ${f.input.requestId}`,
              due: { date: "2026-10-01T08:00:00+05:30" },
            },
          ]
        : [],
      next_cursor: null,
    });
  };
  try {
    const api = new TodoistApi("synthetic-token", fetcher);
    await f.store.place(f.input, projectId);
    const worker = new Worker(f.store, api);
    await worker.tick();
    await worker.stop();
    assert.equal(creates, 1);
    await f.store.retry(f.input.requestId, api);
    const restarted = new Worker(
      f.store,
      new TodoistApi("synthetic-token", fetcher),
    );
    await restarted.tick();
    assert.equal(creates, 1);
    assert.match((await f.store.board(api)).cards[0].error, /uncertain/);
    visible = true;
    await f.store.retry(f.input.requestId, api);
    await restarted.tick();
    await restarted.stop();
    const row = (await f.store.db.orm.Outbox.all())[0];
    assert.equal(row.state, "saved");
    assert.equal(row.remoteId, "6XGgmFVcrG5RRjVr");
    assert.equal(creates, 1);
  } finally {
    await f.close();
  }
});
test("completed real tasks have no fake request marker and remain noneditable; failures retain usable local board", async () => {
  const f = await fixture();
  try {
    const project = await f.provider.mealsProject();
    f.provider.list = async () => [
      {
        id: "opaque-real-id",
        projectId: project.id,
        name: "Completed",
        date: f.input.date,
        time: "08:00",
        requestId: "",
        completed: true,
      },
    ];
    const board = await f.store.board(f.provider);
    assert.equal(board.cards[0].completed, true);
    assert.equal(board.cards[0].requestId, "");
    await assert.rejects(
      f.store.change(
        { requestId: randomUUID(), taskId: "opaque-real-id", kind: "delete" },
        f.provider,
      ),
      /completed/,
    );
    f.provider.list = async () => {
      throw new Error("Todoist request failed (503)");
    };
    const failed = await f.store.board(f.provider);
    assert.equal(failed.cards.length, 1);
    assert.equal(failed.library.length, 3);
    assert.match(failed.integrationError ?? "", /503/);
  } finally {
    await f.close();
  }
});

test("slot save migrates prior aliases, excludes completed meals and refuses occupied slot removal", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    const board = await f.store.board(f.provider);
    const setting = (await f.store.db.orm.Setting.all())[0];
    await f.store.db.orm.Setting.where({ id: setting.id }).update({
      value: JSON.stringify({
        ...board.settings,
        aliases: { "07:45": f.input.slotId },
      }),
    });
    const list = f.provider.list.bind(f.provider);
    f.provider.list = async (projectId) => {
      const remote = await list(projectId);
      return [
        ...remote.map((task) => ({ ...task, time: "07:45" })),
        {
          ...remote[0],
          id: "completed-history",
          completed: true,
          time: "07:45",
        },
      ];
    };
    await assert.rejects(
      f.store.saveSlots(
        board.slots.filter((slot) => slot.id !== f.input.slotId),
        board.settings.revision,
        f.provider,
      ),
      /Move or complete/,
    );
    await f.store.saveSlots(board.slots, board.settings.revision, f.provider);
    const pending = (await f.store.db.orm.Outbox.all()).filter(
      (row) => row.state === "pending",
    );
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0].payload).time, "08:00");
    assert.notEqual(JSON.parse(pending[0].payload).taskId, "completed-history");
  } finally {
    await f.close();
  }
});
