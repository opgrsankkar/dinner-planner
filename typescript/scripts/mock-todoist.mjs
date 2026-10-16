// Test-only Node preload that replaces globalThis.fetch with an in-memory
// Todoist API v1 so the production server can run the real LiveTodoist
// transport (including its listing cache) without any network or account.
// Never used by the deployed application; loaded only via `node --import`.
import { randomUUID } from "node:crypto";

const host = "api.todoist.com";
const project = "browser-meals-project";
const tasks = new Map();
const originalFetch = globalThis.fetch;

function json(body, status = 200) {
  return Response.json(body, { status });
}

function toTask(input, id = randomUUID(), checked = false) {
  return {
    id,
    project_id: input.project_id,
    content: input.content,
    description: input.description,
    due: { date: input.due_datetime },
    checked,
  };
}

globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.hostname !== host) return originalFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  if (path.endsWith("/projects"))
    return json({ results: [{ id: project, name: "Meals" }], next_cursor: null });
  if (path.includes("/tasks/completed/by_due_date"))
    return json({ items: [], next_cursor: null });
  if (path === "/api/v1/tasks" && method === "GET")
    return json({ results: [...tasks.values()], next_cursor: null });
  if (path === "/api/v1/tasks" && method === "POST") {
    const task = toTask(body);
    tasks.set(task.id, task);
    return json(task);
  }
  const match = path.match(/^\/api\/v1\/tasks\/([^/]+?)(\/close)?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const task = tasks.get(id);
    if (match[2]) {
      if (!task) return new Response(null, { status: 404 });
      task.checked = true;
      return new Response(null, { status: 204 });
    }
    if (method === "GET")
      return task ? json(task) : new Response(null, { status: 404 });
    if (method === "POST") {
      if (!task) return new Response(null, { status: 404 });
      task.due = { date: String(body.due_datetime) };
      return json(task);
    }
    if (method === "DELETE") {
      tasks.delete(id);
      return new Response(null, { status: 204 });
    }
  }
  return new Response(`Unhandled mock Todoist request ${method} ${path}`, {
    status: 500,
  });
};
