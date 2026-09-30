import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TodoistApi,
  TodoistError,
  remoteMeal,
} from "../src/server/todoist-api";
import type { Placement } from "../src/types";
const project = "6XGgm6PHrGgMpCFX";
const requestId = "f72d2fa1-2705-469c-826c-a13d1076e191";
const placement: Placement = {
  projectId: project,
  mealId: "library",
  slotId: "slot",
  name: "Dal",
  date: "2026-10-01",
  time: "13:00",
};
const task = (changes = {}) => ({
  id: "6XGgmFVcrG5RRjVr",
  project_id: project,
  content: "Dal",
  description: "Family notes",
  due: {
    date: "2026-10-01T07:30:00Z",
    timezone: "Asia/Kolkata",
    is_recurring: false,
  },
  checked: false,
  ...changes,
});
type Call = {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
};
function fixture(
  reply: (call: Call, index: number) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  let now = Date.parse("2026-10-01T00:00:00Z");
  const fetcher: typeof fetch = async (url, init) => {
    const call = {
      url: new URL(String(url)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return {
    api: new TodoistApi("synthetic-token", fetcher, () => now, 10),
    calls,
    advance(ms: number) {
      now += ms;
    },
  };
}
const json = (body: unknown) => Response.json(body);
test("v1 exact project pagination and cache; opaque cursor survives encoding", async () => {
  const f = fixture((call) =>
    call.url.searchParams.has("cursor")
      ? json({ results: [{ id: project, name: "Meals" }], next_cursor: null })
      : json({
          results: [{ id: "other", name: "meals" }],
          next_cursor: "opaque+/.cursor",
        }),
  );
  assert.equal((await f.api.mealsProject()).id, project);
  await Promise.all(Array.from({ length: 30 }, () => f.api.mealsProject()));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url.searchParams.get("cursor"), "opaque+/.cursor");
  assert.equal(
    f.calls[0].headers.get("Authorization"),
    "Bearer synthetic-token",
  );
  f.advance(61000);
  await f.api.mealsProject();
  assert.equal(f.calls.length, 4);
});
test("missing/ambiguous projects fail visibly and failures are bounded", async () => {
  for (const results of [
    [],
    [
      { id: "a", name: "Meals" },
      { id: "b", name: "Meals" },
    ],
  ]) {
    const f = fixture(() => json({ results, next_cursor: null }));
    await assert.rejects(f.api.mealsProject(), /exactly one/);
    await assert.rejects(f.api.mealsProject(), /exactly one/);
    assert.equal(f.calls.length, 1);
  }
});
test("active and completed due-history pagination use real response envelopes, scope, dedupe, cache", async () => {
  const f = fixture((call) => {
    if (call.url.pathname.endsWith("by_due_date"))
      return json({
        items: [
          task({ id: "completed", checked: true }),
          task({ id: "alien", project_id: "wrong" }),
        ],
        next_cursor: call.url.searchParams.has("cursor")
          ? null
          : "completed.cursor",
      });
    return json({
      results: [task(), task({ id: "alien", project_id: "wrong" })],
      next_cursor: call.url.searchParams.has("cursor") ? null : "active.cursor",
    });
  });
  const meals = await f.api.list(project, { week: "2026-09-28" });
  assert.equal(meals.length, 2);
  assert.equal(meals.find((t) => t.id === "completed")?.completed, true);
  assert.equal(meals[1].requestId, "");
  assert.equal(meals[1].time, "13:00");
  for (const call of f.calls)
    assert.equal(call.url.searchParams.get("project_id"), project);
  assert.equal(
    f.calls[2].url.searchParams.get("since"),
    "2026-09-27T18:30:00.000Z",
  );
  await Promise.all(
    Array.from({ length: 20 }, () =>
      f.api.list(project, { week: "2026-09-28" }),
    ),
  );
  assert.equal(f.calls.length, 4);
  f.advance(61000);
  await f.api.list(project, { week: "2026-09-28" });
  assert.equal(f.calls.length, 8);
});
test("date/time normalization handles v1, legacy, floating, invalid and missing due without inventing a slot", () => {
  for (const due of [
    { date: "2026-10-01T07:30:00Z" },
    { datetime: "2026-10-01T13:00:00+05:30" },
    { date: "2026-10-01T13:00:00", timezone: "Asia/Kolkata" },
  ])
    assert.equal(remoteMeal(task({ due })).time, "13:00");
  assert.equal(
    remoteMeal(task({ due: { date: "2026-09-30T20:00:00Z" } })).date,
    "2026-10-01",
  );
  for (const due of [
    null,
    { date: "bad" },
    { date: "2026-02-30" },
    { date: "2026-10-01" },
    { date: "2026-10-01T13:00:00", timezone: "Europe/London" },
  ]) {
    const meal = remoteMeal(task({ due }));
    assert.equal(meal.time, "");
    assert.ok(meal.dueError);
  }
});
test("create uses stable request header, durable description marker and Kolkata RFC3339 offset", async () => {
  const f = fixture((call) =>
    call.url.pathname.endsWith("projects")
      ? json({ results: [{ id: project, name: "Meals" }], next_cursor: null })
      : json(task({ description: call.body?.description })),
  );
  const created = await f.api.create(placement, requestId);
  assert.equal(created.requestId, requestId);
  assert.deepEqual(f.calls[1].body, {
    content: "Dal",
    project_id: project,
    description: `meal-planner-request-id: ${requestId}`,
    due_datetime: "2026-10-01T13:00:00+05:30",
  });
  assert.equal(f.calls[1].headers.get("X-Request-Id"), requestId);
});
test("move encodes opaque ID, checks ownership, preserves description and handles update failure", async () => {
  const opaque = "opaque /?#+";
  const f = fixture((call) =>
    json(
      task({
        id: opaque,
        ...(call.method === "POST"
          ? { due: { date: call.body?.due_datetime } }
          : {}),
      }),
    ),
  );
  const updated = await f.api.move({ ...placement, taskId: opaque }, requestId);
  assert.equal(updated.description, "Family notes");
  assert.equal(updated.time, "13:00");
  assert.equal(
    f.calls[0].url.pathname,
    `/api/v1/tasks/${encodeURIComponent(opaque)}`,
  );
  assert.deepEqual(f.calls[1].body, {
    due_datetime: "2026-10-01T13:00:00+05:30",
  });
  const denied = fixture(() => json(task({ project_id: "wrong" })));
  await assert.rejects(
    denied.api.move({ ...placement, taskId: opaque }, requestId),
    /belongs/,
  );
  assert.equal(denied.calls.length, 1);
  const failed = fixture((call) =>
    call.method === "POST"
      ? new Response("synthetic-token", { status: 503 })
      : json(task()),
  );
  await assert.rejects(
    failed.api.move({ ...placement, taskId: task().id }, requestId),
    /\(503\)/,
  );
  assert.equal(failed.calls.length, 2);
});
test("DELETE success and 404 acknowledge without an immediate GET", async () => {
  for (const status of [204, 404]) {
    const f = fixture((call) =>
      call.method === "GET" ? json(task()) : new Response(null, { status }),
    );
    await f.api.delete(task().id, project, requestId);
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["GET", "DELETE"],
    );
    assert.equal(f.calls[1].headers.get("X-Request-Id"), requestId);
  }
  const gone = fixture(() => new Response(null, { status: 404 }));
  await gone.api.delete("gone", project, requestId);
  assert.equal(gone.calls.length, 1);
});
test("completed tasks cannot be moved or deleted; foreign task cannot be deleted", async () => {
  for (const payload of [
    task({ checked: true }),
    task({ project_id: "elsewhere" }),
  ]) {
    const f = fixture(() => json(payload));
    await assert.rejects(f.api.delete(task().id, project, requestId));
    assert.equal(f.calls.length, 1);
  }
});
test("rate limits honor Retry-After, do not hammer, and never leak error bodies", async () => {
  const f = fixture(
    () =>
      new Response("synthetic-token secret", {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
  );
  await assert.rejects(
    f.api.get("task", project),
    (error: unknown) =>
      error instanceof TodoistError &&
      error.retryAfterMs === 120000 &&
      !error.message.includes("token"),
  );
  await assert.rejects(f.api.get("task", project), /waiting/);
  assert.equal(f.calls.length, 1);
  f.advance(120001);
  await assert.rejects(f.api.get("task", project));
  assert.equal(f.calls.length, 2);
});
test("transport failure and timeout are safe; writes are uncertain", async () => {
  const f = fixture((call) => {
    if (call.url.pathname.endsWith("projects"))
      return json({
        results: [{ id: project, name: "Meals" }],
        next_cursor: null,
      });
    throw new Error("Authorization: Bearer synthetic-token");
  });
  await assert.rejects(
    f.api.create(placement, requestId),
    (error: unknown) =>
      error instanceof TodoistError &&
      error.uncertain &&
      !error.message.includes("token"),
  );
  const fetcher: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("secret")),
      );
    });
  const api = new TodoistApi("synthetic-token", fetcher, Date.now, 5);
  await assert.rejects(api.get("task", project), /timed out/);
});
test("pagination loop and malformed envelopes fail; external changes appear after cache TTL", async () => {
  const loop = fixture(() => json({ results: [], next_cursor: "same.cursor" }));
  await assert.rejects(loop.api.list(project), /repeated/);
  let title = "Dal";
  const f = fixture(() =>
    json({ results: [task({ content: title })], next_cursor: null }),
  );
  assert.equal((await f.api.list(project))[0].name, "Dal");
  title = "Externally edited";
  assert.equal((await f.api.list(project))[0].name, "Dal");
  f.advance(15001);
  assert.equal((await f.api.list(project))[0].name, title);
});
