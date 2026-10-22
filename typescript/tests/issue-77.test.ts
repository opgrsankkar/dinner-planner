import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, Worker } from "../src/server/store";
import { FakeTodoist, completionRequestId } from "../src/server/todoist";
import { LocalPlan } from "../src/server/local-plan";
import { TodoistApi } from "../src/server/todoist-api";
import type { Placement } from "../src/types";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "planner-issue-77-"));
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/init-db.ts"],
    {
      env: { ...process.env, DATABASE_PATH: join(root, "template.sqlite") },
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
  const project = await provider.mealsProject();
  const input = (date: string) => ({
    requestId: randomUUID(),
    mealId: board.library[0]!.id,
    slotId: board.slots[0]!.id,
    date,
  });
  let closed = false;
  return {
    store,
    provider,
    worker,
    project,
    path,
    providerPath,
    input,
    async close() {
      if (closed) return;
      closed = true;
      await worker.stop();
      await store.close();
      provider.close();
    },
  };
}

async function localFixture() {
  const directory = await mkdtemp(join(root, "local-"));
  const path = join(directory, "planner.sqlite");
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed(false);
  const meal = await store.addLibrary("Local past meal");
  const provider = new LocalPlan(store);
  const board = await store.board(provider);
  const input = (date: string) => ({
    requestId: randomUUID(),
    mealId: meal.id,
    slotId: board.slots[0]!.id,
    date,
  });
  return { store, provider, board, input, worker: new Worker(store, provider) };
}

test("a past placement is shown complete immediately, then created and completed in Todoist", async () => {
  const f = await fixture();
  try {
    const past = f.input("2020-01-01");
    await f.store.place(past, f.project.id);
    const optimistic = (await f.store.board(f.provider)).cards[0]!;
    assert.equal(optimistic.state, "pending");
    assert.equal(optimistic.completed, true);
    const payload = JSON.parse(
      (await f.store.db.outboxAll())[0]!.payload,
    ) as Placement;
    assert.equal(payload.complete, true);
    assert.equal((await f.provider.list(f.project.id)).length, 0);

    await f.worker.tick();
    const tasks = await f.provider.list(f.project.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.completed, true);
    assert.equal(f.provider.createCalls, 1);
    assert.equal(f.provider.completeCalls, 1);
    assert.equal((await f.store.db.outboxAll())[0]!.state, "saved");
    assert.equal((await f.store.board(f.provider)).cards[0]!.completed, true);
  } finally {
    await f.close();
  }
});

test("future placements are created and left open", async () => {
  const f = await fixture();
  try {
    const future = f.input("2999-01-01");
    await f.store.place(future, f.project.id);
    assert.notEqual((await f.store.board(f.provider)).cards[0]!.completed, true);
    await f.worker.tick();
    assert.equal(f.provider.createCalls, 1);
    assert.equal(f.provider.completeCalls, 0);
    const task = (await f.provider.list(f.project.id)).find(
      (item) => item.requestId === future.requestId,
    )!;
    assert.notEqual(task.completed, true);
    assert.notEqual((await f.store.board(f.provider)).cards[0]!.completed, true);
  } finally {
    await f.close();
  }
});

test("a completion failure after create retries without a duplicate create", async () => {
  const f = await fixture();
  try {
    const past = f.input("2020-01-02");
    await f.store.place(past, f.project.id);
    f.provider.completeFailBefore = 1;
    await f.worker.tick();
    assert.equal(f.provider.createCalls, 1);
    assert.equal(f.provider.completeCalls, 1);
    const pending = (await f.store.db.outboxAll())[0]!;
    assert.equal(pending.state, "pending");
    assert.ok(pending.remoteId);
    assert.match(pending.error, /complete unavailable/);
    assert.notEqual((await f.provider.list(f.project.id))[0]!.completed, true);

    await f.store.retry(past.requestId, f.provider);
    await f.worker.tick();
    assert.equal(f.provider.createCalls, 1);
    assert.equal(f.provider.completeCalls, 2);
    const tasks = await f.provider.list(f.project.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.completed, true);
    assert.equal((await f.store.db.outboxAll())[0]!.state, "saved");
  } finally {
    await f.close();
  }
});

test("a lost completion response reconciles after restart without a duplicate create", async () => {
  const f = await fixture();
  await f.store.place(f.input("2020-01-03"), f.project.id);
  f.provider.completeLoseResponse = 1;
  await f.worker.tick();
  assert.equal(f.provider.createCalls, 1);
  assert.equal(f.provider.completeCalls, 1);
  assert.equal((await f.provider.list(f.project.id))[0]!.completed, true);
  assert.equal((await f.store.db.outboxAll())[0]!.state, "pending");
  await f.close();

  const store = new Store(f.path);
  const provider = new FakeTodoist(f.providerPath);
  provider.delayMs = 0;
  const worker = new Worker(store, provider);
  try {
    await new Promise((resolve) => setTimeout(resolve, 550));
    await worker.tick();
    assert.equal(provider.createCalls, 0);
    assert.equal(provider.completeCalls, 0);
    assert.equal((await provider.list(f.project.id)).length, 1);
    assert.equal((await store.board(provider)).cards[0]!.completed, true);
    assert.equal((await store.db.outboxAll())[0]!.state, "saved");
  } finally {
    await worker.stop();
    await store.close();
    provider.close();
  }
});

test("existing placements without a completion intent are never retroactively completed", async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.store.db.outboxInsert({
      id,
      payload: JSON.stringify({
        mealId: f.input("2020-01-04").mealId,
        name: "Legacy past meal",
        slotId: f.input("2020-01-04").slotId,
        time: "08:00",
        date: "2020-01-04",
        projectId: f.project.id,
      } satisfies Placement),
      state: "pending",
      error: "",
      remoteId: "",
      attempted: "0",
      nextAt: "0",
      confirmedAt: "0",
    });
    await f.worker.tick();
    assert.equal(f.provider.createCalls, 1);
    assert.equal(f.provider.completeCalls, 0);
    assert.notEqual((await f.provider.list(f.project.id))[0]!.completed, true);
    assert.equal((await f.store.board(f.provider)).cards[0]!.completed, undefined);
  } finally {
    await f.close();
  }
});

test("Todoist transport: lost close response recovers after restart with no duplicate create or close", async () => {
  const projectId = "6XGgm6PHrGgMpCFX";
  const directory = await mkdtemp(join(root, "transport-"));
  const path = join(directory, "planner.sqlite");
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed();
  const meal = (await store.db.libraryAll())[0]!;
  const slot = (await store.db.slotAll()).find((item) => item.time === "08:00")!;

  let completed = false;
  let creates = 0;
  let closes = 0;
  let loseNextClose = true;
  const closeIds: string[] = [];
  let task: Record<string, unknown> | null = null;
  const taskValue = () => ({
    id: "6XGgmFVcrG5RRjVr",
    project_id: projectId,
    content: meal.name,
    description: `meal-planner-request-id: ${createRequestId}`,
    due: { date: "2020-01-05T08:00:00+05:30" },
    checked: completed,
    ...(completed ? { completed_at: "2020-01-05T08:05:00Z" } : {}),
  });
  let createRequestId = "";
  const seen = new Map<string, Response>();
  const fetcher: typeof fetch = async (url, init) => {
    const call = {
      url: new URL(String(url)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    if (call.url.pathname.endsWith("projects"))
      return Response.json({
        results: [{ id: projectId, name: "Meals" }],
        next_cursor: null,
      });
    const key = call.headers.get("X-Request-Id") ?? "";
    if (key && seen.has(key)) return seen.get(key)!.clone();
    let response: Response;
    if (call.method === "POST" && call.url.pathname === "/api/v1/tasks") {
      creates++;
      createRequestId = key;
      task = taskValue();
      response = Response.json(task);
    } else if (
      call.method === "POST" &&
      call.url.pathname.endsWith("/close")
    ) {
      closes++;
      closeIds.push(key);
      completed = true;
      if (loseNextClose) {
        loseNextClose = false;
        throw new Error("Todoist connection dropped after close");
      }
      response = new Response(null, { status: 204 });
    } else if (
      call.method === "GET" &&
      call.url.pathname.startsWith("/api/v1/tasks/")
    ) {
      response = Response.json(task ? taskValue() : {});
    } else {
      response = Response.json({
        results: completed ? [] : task ? [task] : [],
        items: completed ? [task] : [],
        next_cursor: null,
      });
    }
    if (key) seen.set(key, response.clone());
    return response;
  };

  const requestId = randomUUID();
  await store.place(
    { requestId, mealId: meal.id, slotId: slot.id, date: "2020-01-05" },
    projectId,
  );
  const workerOne = new Worker(store, new TodoistApi("synthetic-token", fetcher));
  try {
    await workerOne.tick();
    assert.equal(creates, 1);
    assert.equal(closes, 1);
    assert.equal(completed, true);
    assert.notEqual(closeIds[0], requestId);
    assert.equal(closeIds[0], completionRequestId(requestId));
    const row = (await store.db.outboxAll())[0]!;
    assert.equal(row.state, "pending");
    assert.ok(row.remoteId);

    // Restart: retry the same durable intent with a fresh transport instance.
    await store.retry(requestId, new TodoistApi("synthetic-token", fetcher));
    const workerTwo = new Worker(store, new TodoistApi("synthetic-token", fetcher));
    await workerTwo.tick();
    assert.equal(creates, 1);
    assert.equal(closes, 1);
    const saved = (await store.db.outboxAll())[0]!;
    assert.equal(saved.state, "saved");
    assert.equal((await store.board(new TodoistApi("synthetic-token", fetcher))).cards[0]!.completed, true);
  } finally {
    await store.close();
  }
});

test("standalone local mode completes past meals and leaves future meals open", async () => {
  const f = await localFixture();
  try {
    const past = f.input("2020-02-01");
    await f.store.place(past, f.board.projectId);
    assert.equal((await f.store.board(f.provider)).cards[0]!.completed, true);
    await f.worker.tick();
    // Local listings cover recent weeks unless a week is requested.
    const pastWeek = { week: "2020-01-27" };
    const saved = (await f.provider.list(f.board.projectId, pastWeek)).find(
      (item) => item.requestId === past.requestId,
    )!;
    assert.equal(saved.completed, true);
    assert.equal((await f.store.board(f.provider, pastWeek.week)).cards[0]!.completed, true);

    const future = f.input("2999-02-01");
    await f.store.place(future, f.board.projectId);
    await f.worker.tick();
    const futureTask = (await f.provider.list(f.board.projectId)).find(
      (item) => item.requestId === future.requestId,
    )!;
    assert.notEqual(futureTask.completed, true);
  } finally {
    await f.store.close();
  }
});

test("local completion lost acknowledgement retries without duplicating or resurrecting", async () => {
  const f = await localFixture();
  try {
    const past = f.input("2020-02-02");
    const complete = f.provider.complete.bind(f.provider);
    let fail = true;
    f.provider.complete = async (taskId, owner, requestId) => {
      await complete(taskId, owner, requestId);
      if (fail) {
        fail = false;
        throw new Error("Lost local completion acknowledgement");
      }
    };
    await f.store.place(past, f.board.projectId);
    await f.worker.tick();
    assert.equal((await f.store.db.outboxAll())[0]!.state, "pending");
    const pastWeek = { week: "2020-01-27" };
    const afterFirst = (await f.provider.list(f.board.projectId, pastWeek)).filter(
      (item) => item.requestId === past.requestId,
    );
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0]!.completed, true);

    await f.store.retry(past.requestId, f.provider);
    await f.worker.tick();
    const afterRetry = (await f.provider.list(f.board.projectId, pastWeek)).filter(
      (item) => item.requestId === past.requestId,
    );
    assert.equal(afterRetry.length, 1);
    assert.equal(afterRetry[0]!.completed, true);
    assert.equal((await f.store.db.outboxAll())[0]!.state, "saved");
    assert.equal((await f.store.board(f.provider, pastWeek.week)).cards[0]!.state, "saved");
  } finally {
    await f.store.close();
  }
});
