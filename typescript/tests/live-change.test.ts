import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, Worker } from "../src/server/store";
import { TodoistApi } from "../src/server/todoist-api";
import type { Placement } from "../src/types";

// These tests exercise the real LiveTodoist transport (TodoistApi) against an
// in-memory fetch mock. They reproduce the reported bug where a meal created a
// moment ago could not be deleted/moved because change() validated against a
// stale cached active listing.
const projectId = "live-meals-project";
type RemoteTask = {
  id: string;
  project_id: string;
  content: string;
  description: string;
  due: { date: string };
  checked: boolean;
};

function liveFixture() {
  const tasks = new Map<string, RemoteTask>();
  const calls: { method: string; path: string; requestId?: string }[] = [];
  // Fail the next N calls of a step ("reopen", "close", "update") with a 503.
  const failures = new Map<string, number>();
  // Apply the next N calls of a step, then report a 503 (a lost acknowledgement).
  const lostAcks = new Map<string, number>();
  const take = (map: Map<string, number>, step: string) => {
    const left = map.get(step) ?? 0;
    if (left > 0) map.set(step, left - 1);
    return left > 0;
  };
  let gate: Promise<void> | null = null;
  let lists = 0;
  const make = (
    id: string,
    input: { project_id: string; content: string; description: string; due_datetime: string },
    checked = false,
  ): RemoteTask => ({
    id,
    project_id: input.project_id,
    content: input.content,
    description: input.description,
    due: { date: input.due_datetime },
    checked,
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, requestId: new Headers(init?.headers).get("X-Request-Id") ?? undefined });
    if (path.endsWith("/projects"))
      return Response.json({
        results: [{ id: projectId, name: "Meals" }],
        next_cursor: null,
      });
    if (path.includes("/tasks/completed/by_due_date"))
      return Response.json({ items: [], next_cursor: null });
    if (path === "/api/v1/tasks" && method === "GET") {
      lists++;
      const snapshot = [...tasks.values()];
      if (gate) await gate;
      return Response.json({ results: snapshot, next_cursor: null });
    }
    if (path === "/api/v1/tasks" && method === "POST") {
      const task = make(randomUUID(), body);
      tasks.set(task.id, task);
      return Response.json(task);
    }
    const match = path.match(/^\/api\/v1\/tasks\/([^/]+?)(\/close|\/reopen)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const task = tasks.get(id);
      const step = match[2] ? match[2].slice(1) : method === "POST" ? "update" : method;
      if (take(failures, step)) return new Response(null, { status: 503 });
      if (match[2]) {
        if (!task) return new Response(null, { status: 404 });
        task.checked = match[2] === "/close";
        if (take(lostAcks, step)) return new Response(null, { status: 503 });
        return new Response(null, { status: 204 });
      }
      if (method === "GET")
        return task
          ? Response.json(task)
          : new Response(null, { status: 404 });
      if (method === "POST") {
        if (!task) return new Response(null, { status: 404 });
        task.due = { date: String(body.due_datetime) };
        return Response.json(task);
      }
      if (method === "DELETE") {
        if (!task) return new Response(null, { status: 404 });
        tasks.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unhandled mock Todoist request ${method} ${path}`);
  };
  return {
    api: new TodoistApi("synthetic-token", fetcher),
    tasks,
    calls,
    failures,
    lostAcks,
    listCount: () => lists,
    holdLists() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "planner-live-change-"));
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

async function setup() {
  const directory = await mkdtemp(join(root, "case-"));
  const path = join(directory, "planner.sqlite");
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed();
  const live = liveFixture();
  const worker = new Worker(store, live.api);
  const board = await store.board(live.api);
  const input = {
    requestId: randomUUID(),
    mealId: board.library[0].id,
    slotId: board.slots[0].id,
    date: "2030-10-01",
  };
  const placement: Placement = {
    projectId,
    mealId: board.library[0].id,
    slotId: board.slots[0].id,
    name: board.library[0].name,
    date: "2030-10-01",
    time: board.slots[0].time,
  };
  let closed = false;
  return {
    store,
    worker,
    board,
    input,
    placement,
    ...live,
    async close() {
      if (closed) return;
      closed = true;
      await worker.stop();
      await store.close();
    },
  };
}

// Place and confirm a meal through the outbox, returning its remote ID. The
// worker's pre-create fresh listing is what leaves the active cache stale.
async function createSavedMeal(
  f: Awaited<ReturnType<typeof setup>>,
  requestId = f.input.requestId,
) {
  await f.store.place({ ...f.input, requestId }, projectId);
  await f.worker.tick();
  const row = (await f.store.db.outboxAll()).find((item) => item.id === requestId);
  assert.equal(row?.state, "saved");
  assert.ok(row?.remoteId);
  return row!.remoteId;
}

test("immediate delete after create succeeds despite stale active cache", async () => {
  const f = await setup();
  try {
    const taskId = await createSavedMeal(f);
    const deletion = { requestId: randomUUID(), taskId, kind: "delete" as const };
    await f.store.change(deletion, f.api);
    await f.worker.tick();
    assert.equal(f.tasks.size, 0);
    assert.equal((await f.store.db.outboxGet(deletion.requestId))?.state, "saved");
  } finally {
    await f.close();
  }
});

test("immediate move after create succeeds despite stale active cache", async () => {
  const f = await setup();
  try {
    const taskId = await createSavedMeal(f);
    const target = f.board.slots[1];
    const move = {
      requestId: randomUUID(),
      taskId,
      kind: "move" as const,
      slotId: target.id,
      date: f.input.date,
    };
    await f.store.change(move, f.api);
    await f.worker.tick();
    const task = f.tasks.get(taskId)!;
    assert.match(task.due.date, new RegExp(`T${target.time}:00`));
    assert.equal((await f.store.db.outboxGet(move.requestId))?.state, "saved");
  } finally {
    await f.close();
  }
});

test("absent and foreign tasks stay protected with authoritative lookup", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.store.change(
        { requestId: randomUUID(), taskId: randomUUID(), kind: "delete" },
        f.api,
      ),
      /missing or does not belong/,
    );
    f.tasks.set("foreign-task", {
      id: "foreign-task",
      project_id: "other-project",
      content: "Foreign meal",
      description: "",
      due: { date: "2030-10-01T08:00:00+05:30" },
      checked: false,
    });
    await assert.rejects(
      f.store.change(
        { requestId: randomUUID(), taskId: "foreign-task", kind: "delete" },
        f.api,
      ),
      /belong/,
    );
  } finally {
    await f.close();
  }
});

// A completed meal (one added to a past slot, or ticked off) can still be
// fixed: it is reopened, changed, and a moved meal is completed again.
function addCompleted(f: Awaited<ReturnType<typeof setup>>) {
  f.tasks.set("done-task", {
    id: "done-task",
    project_id: projectId,
    content: "Completed meal",
    description: "",
    due: { date: "2030-10-01T08:00:00+05:30" },
    checked: true,
  });
  return {
    requestId: randomUUID(),
    taskId: "done-task",
    kind: "move" as const,
    slotId: f.board.slots[1].id,
    date: "2030-10-02",
  };
}
const steps = (f: Awaited<ReturnType<typeof setup>>) =>
  f.calls
    .filter((call) => call.method !== "GET" && call.path.startsWith("/api/v1/tasks/done-task"))
    .map((call) => (call.method === "DELETE" ? "delete" : call.path.endsWith("/reopen") ? "reopen" : call.path.endsWith("/close") ? "close" : "update"));

test("a completed meal is reopened, moved and completed again", async () => {
  const f = await setup();
  try {
    const move = addCompleted(f);
    await f.store.change(move, f.api);
    const pending = (await f.store.board(f.api, "2030-09-30")).cards.find((card) => card.id === "done-task");
    assert.equal(pending?.completed, true, "the pending card stays completed");
    await f.worker.tick();
    assert.equal((await f.store.db.outboxGet(move.requestId))?.state, "saved");
    const task = f.tasks.get("done-task")!;
    assert.match(task.due.date, new RegExp(`^2030-10-02T${f.board.slots[1].time}:00`));
    assert.equal(task.checked, true, "the moved meal is completed again");
    assert.deepEqual(steps(f), ["reopen", "update", "close"]);
    const ids = f.calls.filter((call) => call.path.startsWith("/api/v1/tasks/done-task") && call.method !== "GET").map((call) => call.requestId);
    assert.equal(new Set(ids).size, 3, "each step has its own request ID");
    const card = (await f.store.board(f.api, "2030-09-30")).cards.find((card) => card.id === "done-task");
    assert.equal(card?.date, "2030-10-02");
    assert.equal(card?.completed, true);
  } finally {
    await f.close();
  }
});

test("a completed meal is reopened then deleted", async () => {
  const f = await setup();
  try {
    const deletion = { requestId: randomUUID(), taskId: addCompleted(f).taskId, kind: "delete" as const };
    await f.store.change(deletion, f.api);
    await f.worker.tick();
    assert.equal((await f.store.db.outboxGet(deletion.requestId))?.state, "saved");
    assert.equal(f.tasks.has("done-task"), false);
    assert.deepEqual(steps(f), ["reopen", "delete"]);
  } finally {
    await f.close();
  }
});

test("moving a completed meal resumes after a failed step without losing completion", async () => {
  for (const failing of ["update", "close"]) {
    const f = await setup();
    try {
      const move = addCompleted(f);
      await f.store.change(move, f.api);
      f.failures.set(failing, 1);
      await f.worker.tick();
      const row = await f.store.db.outboxGet(move.requestId);
      assert.equal(row?.state, "pending", `${failing} failure keeps the move pending`);
      assert.equal(f.tasks.get("done-task")!.checked, false, "the meal is reopened mid-way");
      await f.store.db.outboxUpdate(move.requestId, { nextAt: "0" });
      await f.worker.tick();
      assert.equal((await f.store.db.outboxGet(move.requestId))?.state, "saved", `${failing} failure recovers`);
      const task = f.tasks.get("done-task")!;
      assert.equal(task.checked, true, `${failing} failure still ends completed`);
      assert.match(task.due.date, /^2030-10-02T/);
      assert.equal(steps(f).filter((step) => step === "reopen").length, 1, "the meal is reopened once");
    } finally {
      await f.close();
    }
  }
});

test("a lost close acknowledgement is not repeated on retry", async () => {
  const f = await setup();
  try {
    const move = addCompleted(f);
    await f.store.change(move, f.api);
    f.lostAcks.set("close", 1);
    await f.worker.tick();
    assert.equal((await f.store.db.outboxGet(move.requestId))?.state, "pending");
    assert.equal(f.tasks.get("done-task")!.checked, true);
    await f.store.db.outboxUpdate(move.requestId, { nextAt: "0" });
    await f.worker.tick();
    assert.equal((await f.store.db.outboxGet(move.requestId))?.state, "saved");
    assert.deepEqual(steps(f), ["reopen", "update", "close"], "the finished move is acknowledged without new writes");
  } finally {
    await f.close();
  }
});

test("successful mutations invalidate the active listing cache", async () => {
  const f = await setup();
  try {
    const taskId = await createSavedMeal(f);
    const listed = await f.api.list(projectId);
    assert.ok(
      listed.some((task) => task.id === taskId),
      "create is visible in the next listing without waiting for TTL",
    );
    await f.store.change(
      {
        requestId: randomUUID(),
        taskId,
        kind: "move",
        slotId: f.board.slots[1].id,
        date: f.input.date,
      },
      f.api,
    );
    await f.worker.tick();
    const moved = (await f.api.list(projectId)).find((task) => task.id === taskId);
    assert.equal(moved?.time, f.board.slots[1].time);
    await f.store.change(
      { requestId: randomUUID(), taskId, kind: "delete" },
      f.api,
    );
    await f.worker.tick();
    assert.equal(
      (await f.api.list(projectId)).some((task) => task.id === taskId),
      false,
    );
  } finally {
    await f.close();
  }
});

test("a stale in-flight listing cannot repopulate the cache after a mutation", async () => {
  const f = await setup();
  try {
    const baseline = f.listCount();
    const release = f.holdLists();
    const pending = f.api.list(projectId, { fresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.listCount(), baseline + 1, "listing request is in flight");
    const created = await f.api.create(f.placement, f.input.requestId);
    release();
    await pending;
    const listed = await f.api.list(projectId);
    assert.ok(
      listed.some((task) => task.id === created.id),
      "post-mutation listing does not reuse the stale in-flight snapshot",
    );
  } finally {
    await f.close();
  }
});
