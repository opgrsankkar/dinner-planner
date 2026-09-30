import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Store, Worker } from "./store";
import { FakeTodoist } from "./todoist";
import type { Todoist } from "./todoist";
export type App = {
  store: Store;
  todoist: Todoist;
  worker: Worker;
  password: string;
  origin: string;
  loginFailures: { count: number; resetAt: number };
};
const globalApp = globalThis as typeof globalThis & {
  plannerApp?: Promise<App>;
};
export function app(): Promise<App> {
  return (globalApp.plannerApp ??= (async () => {
    const password = process.env.PLANNER_PASSWORD;
    if (!password)
      throw new Error("Set PLANNER_PASSWORD before starting the offline demo");
    const path = resolve(process.env.PLANNER_DB ?? ".local/planner.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    const store = new Store(path);
    await store.seed();
    const todoist = new FakeTodoist(
      resolve(process.env.FAKE_TODOIST_DB ?? ".local/fake-todoist.sqlite"),
    );
    todoist.delayMs = Number(process.env.FAKE_TODOIST_DELAY_MS ?? 1200);
    todoist.failBefore = Number(process.env.FAKE_TODOIST_FAIL_BEFORE ?? 0);
    todoist.loseResponse = Number(process.env.FAKE_TODOIST_LOSE_RESPONSE ?? 0);
    const worker = new Worker(store, todoist);
    worker.start();
    return {
      store,
      todoist,
      worker,
      password,
      origin: process.env.PLANNER_ORIGIN ?? "http://localhost:3000",
      loginFailures: { count: 0, resetAt: 0 },
    };
  })());
}
function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
function cookie(token: string, origin: string, logout = false) {
  return `planner_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${logout ? 0 : 604800}${origin.startsWith("https:") ? "; Secure" : ""}`;
}
export async function handle(
  request: Request,
  current: App,
): Promise<Response> {
  const { store, todoist, origin } = current;
  const url = new URL(request.url);
  const allowed = new URL(origin);
  const localAlias =
    allowed.hostname === "localhost" &&
    url.hostname === "127.0.0.1" &&
    url.port === allowed.port;
  if (url.host !== allowed.host && !localAlias)
    return json({ error: "Unrecognized host" }, 403);
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin)
    return json({ error: "Invalid request origin" }, 403);
  if (request.method === "GET" && url.pathname === "/api/health")
    return json({ ok: true, provider: "offline-fake" });
  try {
    if (url.pathname === "/api/login" && request.method === "POST") {
      if (Date.now() > current.loginFailures.resetAt)
        current.loginFailures = { count: 0, resetAt: Date.now() + 60000 };
      if (current.loginFailures.count >= 10)
        return json({ error: "Try again in a minute" }, 429);
      const body: unknown = await request.json();
      const password =
        typeof body === "object" &&
        body !== null &&
        "password" in body &&
        typeof body.password === "string"
          ? body.password
          : "";
      const hash = (value: string) =>
        createHash("sha256").update(value).digest();
      if (!timingSafeEqual(hash(password), hash(current.password))) {
        current.loginFailures.count++;
        return json({ error: "Incorrect password" }, 401);
      }
      const session = await store.login();
      current.loginFailures.count = 0;
      return json({ ok: true }, 200, {
        "Set-Cookie": cookie(session.id, origin),
      });
    }
    const token =
      request.headers
        .get("cookie")
        ?.match(/(?:^|;\s*)planner_session=([^;]*)/)?.[1] ?? "";
    const session = await store.session(token);
    if (!session) return json({ error: "Sign in required" }, 401);
    if (
      request.method !== "GET" &&
      request.headers.get("x-csrf-token") !== session.csrf
    )
      return json({ error: "Invalid CSRF token" }, 403);
    if (url.pathname === "/api/logout" && request.method === "POST") {
      await store.logout(token);
      return json({ ok: true }, 200, {
        "Set-Cookie": cookie("", origin, true),
      });
    }
    if (url.pathname === "/api/board" && request.method === "GET")
      return json({ ...(await store.board(todoist)), csrf: session.csrf });
    if (url.pathname === "/api/library" && request.method === "POST") {
      const body = (await request.json()) as { name?: unknown };
      if (typeof body.name !== "string")
        return json({ error: "Meal name required" }, 400);
      return json(await store.addLibrary(body.name));
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      if (
        !["requestId", "mealId", "slotId", "date"].every(
          (key) => typeof body[key] === "string",
        )
      )
        return json({ error: "Invalid placement" }, 400);
      const project = await todoist.mealsProject();
      if (project.name !== "Meals")
        return json({ error: "Meals project unavailable" }, 409);
      const row = await store.place(
        body as {
          requestId: string;
          mealId: string;
          slotId: string;
          date: string;
        },
        project.id,
      );
      return json({ requestId: row.id, state: row.state }, 202);
    }
    return json({ error: "Unknown endpoint" }, 404);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Request failed" },
      400,
    );
  }
}
