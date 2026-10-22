import { createHash, timingSafeEqual } from "node:crypto";
import { mealsCalendar } from "./calendar";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Slot } from "../types";
import { Store, Worker } from "./store";
import { FakeTodoist } from "./todoist";
import { TodoistApi } from "./todoist-api";
import { LocalPlan } from "./local-plan";
import type { Todoist } from "./todoist";
export type App = {
  store: Store;
  todoist: Todoist;
  worker: Worker;
  origin: string;
  // Secret path segment for the read-only calendar feed; empty disables it.
  calendarToken: string;
};
const globalApp = globalThis as typeof globalThis & {
  plannerApp?: Promise<App>;
};
export function app(): Promise<App> {
  return (globalApp.plannerApp ??= (async () => {
    const path = resolve(
      process.env.DATABASE_PATH ??
        process.env.PLANNER_DB ??
        ".local/planner.sqlite",
    );
    mkdirSync(dirname(path), { recursive: true });
    const store = new Store(path);
    await store.seed(process.env.TODOIST_MODE === "fake");
    let todoist: Todoist;
    if (process.env.TODOIST_MODE === "fake") {
      const fake = new FakeTodoist(
        resolve(process.env.FAKE_TODOIST_DB ?? ".local/fake-todoist.sqlite"),
      );
      fake.delayMs = Number(process.env.FAKE_TODOIST_DELAY_MS ?? 1200);
      fake.moveFailBefore = Number(
        process.env.FAKE_TODOIST_MOVE_FAIL_BEFORE ?? 0,
      );
      fake.deleteFailBefore = Number(
        process.env.FAKE_TODOIST_DELETE_FAIL_BEFORE ?? 0,
      );
      fake.failBefore = Number(process.env.FAKE_TODOIST_FAIL_BEFORE ?? 0);
      fake.loseResponse = Number(process.env.FAKE_TODOIST_LOSE_RESPONSE ?? 0);
      todoist = fake;
    } else if (process.env.TODOIST_MODE === "local") {
      todoist = new LocalPlan(store);
    } else {
      if (process.env.TODOIST_MODE && process.env.TODOIST_MODE !== "live")
        throw new Error("Invalid TODOIST_MODE");
      const token =
        process.env.TODOIST_TOKEN?.trim() ||
        (process.env.TODOIST_TOKEN_FILE
          ? readFileSync(process.env.TODOIST_TOKEN_FILE, "utf8").trim()
          : "");
      if (!token)
        throw new Error(
          "Configure TODOIST_TOKEN_FILE or TODOIST_TOKEN; standalone storage requires TODOIST_MODE=local, demo requires TODOIST_MODE=fake",
        );
      todoist = new TodoistApi(token);
    }
    const worker = new Worker(store, todoist);
    worker.start();
    return {
      store,
      todoist,
      worker,
      origin: process.env.PLANNER_ORIGIN ?? "http://localhost:8789",
      calendarToken: process.env.ICS_TOKEN?.trim() ?? "",
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
function sameSecret(a: string, b: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
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
  const allowedHosts = process.env.ALLOWED_HOSTS?.split(",").map((host) =>
    host.trim(),
  );
  if (
    allowedHosts
      ? !allowedHosts.includes(url.hostname)
      : url.host !== allowed.host && !localAlias
  )
    return json({ error: "Unrecognized host" }, 403);
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin)
    return json({ error: "Invalid request origin" }, 403);
  if (request.method === "GET" && url.pathname === "/api/health")
    return json({ ok: true });
  // The planner has no login: Caddy admits only the home network and tailnet.
  // The Origin check above blocks cross-site writes from other pages.
  const feed = url.pathname.match(/^\/api\/calendar\/([A-Za-z0-9_-]{20,})\.ics$/);
  if (request.method === "GET" && feed) {
    if (!current.calendarToken || !sameSecret(feed[1], current.calendarToken))
      return json({ error: "Unknown endpoint" }, 404);
    const board = await store.board(todoist);
    return new Response(mealsCalendar(board.cards, board.slots, new Date()), {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  try {
    if (url.pathname === "/api/board" && request.method === "GET") {
      const week = url.searchParams.get("week") ?? undefined;
      if (
        week &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(week) ||
          !Number.isFinite(Date.parse(week + "T12:00:00Z")))
      )
        throw new Error("Invalid week");
      return json({
        ...(await store.board(todoist, week)),
        calendarUrl: current.calendarToken
          ? `${origin}/api/calendar/${current.calendarToken}.ics`
          : "",
      });
    }
    if (
      request.method === "POST" &&
      [
        "/api/change",
        "/api/retry",
        "/api/settings/slots",
        "/api/settings/theme",
        "/api/library/remove",
        "/api/library/rename",
        "/api/library/shuffle",
      ].includes(url.pathname)
    ) {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid input");
      const fields = body as Record<string, unknown>;
      const string = (key: string) => {
        const value = fields[key];
        if (typeof value !== "string") throw new Error("Invalid " + key);
        return value;
      };
      if (url.pathname === "/api/change") {
        const kind = string("kind");
        if (kind !== "move" && kind !== "delete")
          throw new Error("Invalid action");
        await store.change(
          {
            requestId: string("requestId"),
            taskId: string("taskId"),
            kind,
            ...(kind === "move"
              ? { slotId: string("slotId"), date: string("date") }
              : {}),
          },
          todoist,
        );
      } else if (url.pathname === "/api/retry")
        await store.retry(string("requestId"), todoist);
      else if (url.pathname === "/api/settings/theme") {
        const theme = string("theme");
        if (theme !== "system" && theme !== "light" && theme !== "dark")
          throw new Error("Invalid theme");
        await store.saveTheme(theme);
      } else if (url.pathname === "/api/library/rename")
        await store.renameLibrary(string("mealId"), string("name"));
      else if (url.pathname === "/api/library/remove")
        await store.removeLibrary(string("mealId"));
      else if (url.pathname === "/api/library/shuffle") await store.shuffle();
      else {
        if (
          typeof fields.revision !== "number" ||
          !Number.isInteger(fields.revision) ||
          !Array.isArray(fields.slots)
        )
          throw new Error("Invalid slots");
        const slots: Slot[] = fields.slots.map((value: unknown) => {
          if (
            !value ||
            typeof value !== "object" ||
            !("id" in value) ||
            !("name" in value) ||
            !("time" in value) ||
            typeof value.id !== "string" ||
            typeof value.name !== "string" ||
            typeof value.time !== "string"
          )
            throw new Error("Invalid slot");
          return { id: value.id, name: value.name, time: value.time };
        });
        await store.saveSlots(slots, fields.revision, todoist);
      }
      return json({ ok: true }, 202);
    }
    if (url.pathname === "/api/library" && request.method === "POST") {
      const raw: unknown = await request.json();
      if (!raw || typeof raw !== "object") throw new Error("Invalid input");
      const body = raw as { name?: unknown };
      if (typeof body.name !== "string")
        return json({ error: "Meal name required" }, 400);
      return json(await store.addLibrary(body.name));
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      const raw: unknown = await request.json();
      if (!raw || typeof raw !== "object") throw new Error("Invalid input");
      const body = raw as Record<string, unknown>;
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
