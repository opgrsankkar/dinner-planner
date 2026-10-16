import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TodoistApi } from "../src/server/todoist-api";
import { completionRequestId } from "../src/server/todoist";
import type { Placement } from "../src/types";

// These tests drive the real LiveTodoist transport (TodoistApi) through a fetch
// mock that can lag behind acknowledged writes, exactly like Todoist's
// eventually consistent listings. They pin the user-requested write-through
// behaviour: a confirmed create/move/delete/complete must be visible on the
// very next listing, without waiting for a refetch, and a stale/older listing
// refresh must never erase it.
const project = "write-through-meals";
const otherProject = "unrelated-project";
const lunch = "2026-10-01";
const week = "2026-09-28";
const at = (date: string, time: string) => `${date}T${time}:00+05:30`;
const id = () => randomUUID();
const placement: Placement = {
  projectId: project,
  mealId: "library",
  slotId: "lunch",
  name: "Dal",
  date: lunch,
  time: "13:00",
};
type RemoteTask = {
  id: string;
  project_id: string;
  content: string;
  description: string;
  due: { date: string };
  checked: boolean;
};

function transport() {
  let now = Date.parse("2026-09-01T00:00:00Z");
  const tasks = new Map<string, RemoteTask>();
  // Provider lags: hidden tasks are absent from every listing; ghosts are still
  // listed after they were removed. Both model eventual consistency.
  const hidden = new Set<string>();
  const ghosts = new Map<string, RemoteTask>();
  const calls: { method: string; path: string }[] = [];
  let gate: Promise<void> | null = null;
  let failOnce = false;
  let lagWrites = false;
  const listed = () =>
    [...tasks.values()]
      .filter((task) => !hidden.has(task.id))
      .concat([...ghosts.values()]);
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path });
    if (path.endsWith("/projects"))
      return Response.json({
        results: [{ id: project, name: "Meals" }],
        next_cursor: null,
      });
    const requestProject = url.searchParams.get("project_id") ?? "";
    if (path.includes("/tasks/completed/by_due_date")) {
      const since = Date.parse(url.searchParams.get("since") ?? "");
      const until = Date.parse(url.searchParams.get("until") ?? "");
      const items = listed()
        .filter((task) => task.project_id === requestProject && task.checked)
        .filter((task) => {
          const due = Date.parse(task.due.date);
          return Number.isFinite(due) && due >= since && due < until;
        });
      return Response.json({ items, next_cursor: null });
    }
    if (path === "/api/v1/tasks" && method === "GET") {
      const snapshot = listed().filter(
        (task) => task.project_id === requestProject && !task.checked,
      );
      if (gate) await gate;
      return Response.json({ results: snapshot, next_cursor: null });
    }
    if (path === "/api/v1/tasks" && method === "POST") {
      if (failOnce) {
        failOnce = false;
        return new Response(null, { status: 503 });
      }
      const task: RemoteTask = {
        id: id(),
        project_id: body.project_id,
        content: body.content,
        description: body.description,
        due: { date: body.due_datetime },
        checked: false,
      };
      tasks.set(task.id, task);
      if (lagWrites) hidden.add(task.id);
      return Response.json(task);
    }
    const match = path.match(/^\/api\/v1\/tasks\/([^/]+?)(\/close)?$/);
    if (match) {
      const taskId = decodeURIComponent(match[1]);
      const task = tasks.get(taskId);
      if (match[2]) {
        if (failOnce) {
          failOnce = false;
          return new Response(null, { status: 503 });
        }
        if (!task) return new Response(null, { status: 404 });
        task.checked = true;
        return new Response(null, { status: 204 });
      }
      if (method === "GET")
        return task ? Response.json(task) : new Response(null, { status: 404 });
      if (method === "POST") {
        if (failOnce) {
          failOnce = false;
          return new Response(null, { status: 503 });
        }
        if (!task) return new Response(null, { status: 404 });
        task.due = { date: String(body.due_datetime) };
        return Response.json(task);
      }
      if (method === "DELETE") {
        if (failOnce) {
          failOnce = false;
          return new Response(null, { status: 503 });
        }
        tasks.delete(taskId);
        return new Response(null, { status: 204 });
      }
    }
    return new Response(`Unhandled ${method} ${path}`, { status: 500 });
  };
  return {
    api: new TodoistApi("synthetic-token", fetcher, () => now, 50),
    tasks,
    hidden,
    ghosts,
    calls,
    advance(ms: number) {
      now += ms;
    },
    failNext() {
      failOnce = true;
    },
    lagWrites() {
      lagWrites = true;
    },
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

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for condition");
}

test("confirmed create is visible on the next listing even while Todoist lags", async () => {
  const t = transport();
  t.lagWrites();
  // A provider that has not yet published the create: the forced-fresh read
  // proves the deficiency the write-through overlay fixes.
  const created = await t.api.create(placement, id());
  const fresh = await t.api.list(project, { fresh: true });
  assert.ok(
    fresh.some((task) => task.id === created.id),
    "older refetch cannot hide a confirmed create",
  );
  const cached = await t.api.list(project);
  assert.ok(cached.some((task) => task.id === created.id));
});

test("confirmed move wins over an older in-flight listing", async () => {
  const t = transport();
  const created = await t.api.create(placement, id());
  await t.api.list(project);
  const before = t.calls.length;
  const release = t.holdLists();
  const pending = t.api.list(project, { fresh: true });
  await waitFor(
    () =>
      t.calls.length > before &&
      t.calls[before]?.method === "GET" &&
      t.calls[before]?.path === "/api/v1/tasks",
  );
  await t.api.move(
    { ...placement, taskId: created.id, slotId: "dinner", time: "19:00" },
    id(),
  );
  release();
  const stale = await pending;
  assert.equal(
    stale.find((task) => task.id === created.id)?.time,
    "19:00",
    "an in-flight snapshot resolves through the confirmed move",
  );
  const listed = await t.api.list(project);
  assert.equal(listed.find((task) => task.id === created.id)?.time, "19:00");
});

test("confirmed delete removes the task even when the provider still lists it", async () => {
  const t = transport();
  const created = await t.api.create(placement, id());
  await t.api.list(project);
  // Simulate a stale listing refresh that still reports the deleted task.
  t.ghosts.set(created.id, { ...t.tasks.get(created.id)! });
  await t.api.delete(created.id, project, id());
  assert.ok(!(await t.api.list(project)).some((task) => task.id === created.id));
  assert.ok(
    !(await t.api.list(project, { fresh: true })).some(
      (task) => task.id === created.id,
    ),
  );
});

test("confirmed completion leaves active view and enters the matching weekly history", async () => {
  const t = transport();
  const createId = id();
  const created = await t.api.create(placement, createId);
  await t.api.list(project, { week });
  await t.api.list(project);
  // Provider lags completion in both the active and history listings.
  t.hidden.add(created.id);
  await t.api.complete(created.id, project, completionRequestId(createId));
  const history = (await t.api.list(project, { week })).find(
    (task) => task.id === created.id,
  );
  assert.equal(history?.completed, true, "completion appears in weekly history");
  assert.ok(
    !(await t.api.list(project)).some((task) => task.id === created.id),
    "completion leaves the active view",
  );
  assert.ok(
    !(await t.api.list(project, { week: "2026-10-05" })).some(
      (task) => task.id === created.id,
    ),
    "a completed meal stays out of an unrelated week",
  );
});

test("weekly and active scopes keep active tasks but exclude foreign tasks", async () => {
  const t = transport();
  t.tasks.set("unrelated", {
    id: "unrelated",
    project_id: project,
    content: "Roti",
    description: "",
    due: { date: at("2026-10-05", "19:00") },
    checked: false,
  });
  t.tasks.set("foreign", {
    id: "foreign",
    project_id: otherProject,
    content: "Foreign",
    description: "",
    due: { date: at(lunch, "13:00") },
    checked: false,
  });
  const created = await t.api.create(placement, id());
  const scoped = await t.api.list(project, { week });
  assert.ok(scoped.some((task) => task.id === created.id));
  assert.ok(
    scoped.some((task) => task.id === "unrelated"),
    "active tasks appear in every weekly scope",
  );
  assert.ok(!scoped.some((task) => task.id === "foreign"));
  const active = await t.api.list(project);
  assert.ok(active.some((task) => task.id === "unrelated"));
  assert.ok(!active.some((task) => task.id === "foreign"));
});

test("failed writes never touch the cache", async () => {
  const t = transport();
  const created = await t.api.create(placement, id());
  await t.api.list(project);

  t.failNext();
  await assert.rejects(
    t.api.create({ ...placement, name: "Unconfirmed" }, id()),
    /\(503\)/,
  );
  assert.ok(!(await t.api.list(project)).some((task) => task.name === "Unconfirmed"));

  t.failNext();
  await assert.rejects(
    t.api.move({ ...placement, taskId: created.id, slotId: "dinner", time: "19:00" }, id()),
    /\(503\)/,
  );
  assert.equal((await t.api.list(project)).find((task) => task.id === created.id)?.time, "13:00");

  t.failNext();
  await assert.rejects(t.api.delete(created.id, project, id()), /\(503\)/);
  assert.ok((await t.api.list(project)).some((task) => task.id === created.id));

  t.failNext();
  await assert.rejects(
    t.api.complete(created.id, project, completionRequestId(id())),
    /\(503\)/,
  );
  assert.ok(
    (await t.api.list(project)).some(
      (task) => task.id === created.id && !task.completed,
    ),
  );
});

test("the overlay is bounded: provider truth reconciles after it expires", async () => {
  const t = transport();
  t.lagWrites();
  const created = await t.api.create(placement, id());
  assert.ok((await t.api.list(project)).some((task) => task.id === created.id));
  // Within the overlay window the confirmed write still wins over the lag.
  t.advance(119000);
  assert.ok((await t.api.list(project, { fresh: true })).some((task) => task.id === created.id));
  // Past the window the overlay stops inventing the task and the provider's
  // eventual listing reconciles as the single source of truth.
  t.advance(2000);
  const reconciled = await t.api.list(project, { fresh: true });
  assert.ok(!reconciled.some((task) => task.id === created.id));
  // Once the provider catches up, the task is a normal provider listing again.
  t.hidden.delete(created.id);
  assert.ok((await t.api.list(project, { fresh: true })).some((task) => task.id === created.id));
});

test("acknowledged writes update warmed caches in place without refetching listings", async () => {
  const t = transport();
  // Unrelated data the writes must not disturb, in both scopes.
  t.tasks.set("unrelated-active", {
    id: "unrelated-active",
    project_id: project,
    content: "Upma",
    description: "",
    due: { date: at("2026-10-06", "08:00") },
    checked: false,
  });
  t.tasks.set("unrelated-history", {
    id: "unrelated-history",
    project_id: project,
    content: "Old meal",
    description: "",
    due: { date: at(lunch, "08:00") },
    checked: true,
  });
  const listings = () =>
    t.calls.filter(
      (call) =>
        call.method === "GET" &&
        (call.path === "/api/v1/tasks" ||
          call.path.includes("/tasks/completed/by_due_date")),
    ).length;
  // Warm the active cache plus the matching and adjacent weekly caches.
  await t.api.list(project);
  await t.api.list(project, { week });
  await t.api.list(project, { week: "2026-10-05" });
  const warm = listings();
  assert.ok(warm >= 3, "caches warmed from provider listings");

  const created = await t.api.create(placement, id());
  assert.equal(listings(), warm, "create updated the cache without a refetch");
  const activeAfterCreate = await t.api.list(project);
  const weekAfterCreate = await t.api.list(project, { week });
  assert.equal(listings(), warm, "reads reuse the warmed caches");
  assert.ok(activeAfterCreate.some((task) => task.id === created.id));
  assert.ok(weekAfterCreate.some((task) => task.id === created.id));
  assert.ok(activeAfterCreate.some((task) => task.id === "unrelated-active"));
  assert.ok(weekAfterCreate.some((task) => task.id === "unrelated-history"));

  await t.api.move(
    { ...placement, taskId: created.id, slotId: "dinner", time: "19:00" },
    id(),
  );
  assert.equal(listings(), warm, "move updated the cache without a refetch");
  const activeAfterMove = await t.api.list(project);
  const weekAfterMove = await t.api.list(project, { week });
  assert.equal(listings(), warm);
  assert.equal(
    activeAfterMove.find((task) => task.id === created.id)?.time,
    "19:00",
  );
  assert.equal(
    weekAfterMove.find((task) => task.id === created.id)?.time,
    "19:00",
  );
  assert.ok(activeAfterMove.some((task) => task.id === "unrelated-active"));

  await t.api.complete(created.id, project, completionRequestId(id()));
  assert.equal(listings(), warm, "complete updated the cache without a refetch");
  const activeAfterComplete = await t.api.list(project);
  const weekAfterComplete = await t.api.list(project, { week });
  assert.equal(listings(), warm);
  assert.ok(!activeAfterComplete.some((task) => task.id === created.id));
  assert.equal(
    weekAfterComplete.find((task) => task.id === created.id)?.completed,
    true,
  );
  assert.ok(activeAfterComplete.some((task) => task.id === "unrelated-active"));
  assert.ok(weekAfterComplete.some((task) => task.id === "unrelated-history"));

  const second = await t.api.create({ ...placement, name: "Pongal" }, id());
  await t.api.list(project);
  await t.api.list(project, { week });
  assert.equal(listings(), warm, "second create reused warmed caches");
  await t.api.delete(second.id, project, id());
  assert.equal(listings(), warm, "delete updated the cache without a refetch");
  const activeAfterDelete = await t.api.list(project);
  const weekAfterDelete = await t.api.list(project, { week });
  assert.equal(listings(), warm);
  assert.ok(!activeAfterDelete.some((task) => task.id === second.id));
  assert.ok(activeAfterDelete.some((task) => task.id === "unrelated-active"));
  assert.ok(weekAfterDelete.some((task) => task.id === "unrelated-history"));
});

test("delete overlay survives an older in-flight listing", async () => {
  const t = transport();
  const created = await t.api.create(placement, id());
  await t.api.list(project);
  const before = t.calls.length;
  const release = t.holdLists();
  const pending = t.api.list(project, { fresh: true });
  await waitFor(() => t.calls.length > before && t.calls[before]?.path === "/api/v1/tasks");
  await t.api.delete(created.id, project, id());
  release();
  const stale = await pending;
  assert.ok(
    !stale.some((task) => task.id === created.id),
    "an older listing cannot resurrect a confirmed delete",
  );
});
