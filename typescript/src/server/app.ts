import { createHash, timingSafeEqual } from "node:crypto";
import { mealsCalendar } from "./calendar";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Slot } from "../types";
import { Store } from "./store";
import { RecipeInputError } from "../recipe";
import { kolkataIso, prepRange, RequestError } from "./recipes";
export type App = {
  store: Store;
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
    // PLANNER_DEMO=1 seeds a few sample meals into an empty database.
    await store.seed(process.env.PLANNER_DEMO === "1");
    return {
      store,
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
  const { store, origin } = current;
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
    const board = await store.board();
    return new Response(mealsCalendar(board.cards, board.slots, new Date()), {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  try {
    // Recipe and prep endpoints. Their responses never include the calendar
    // link or any other secret, so the wall display can read them freely.
    const recipePath = url.pathname.match(/^\/api\/recipes\/([^/]+)$/);
    const variantsPath = url.pathname.match(/^\/api\/recipes\/([^/]+)\/variants$/);
    const variantPath = url.pathname.match(/^\/api\/recipes\/([^/]+)\/variants\/([^/]+)$/);
    const all = url.searchParams.get("all") === "1";
    if (url.pathname === "/api/recipes" && request.method === "GET") {
      const name = url.searchParams.get("name");
      return json({ meals: store.recipeIndex(name ?? undefined) });
    }
    if (url.pathname === "/api/recipes" && request.method === "POST") {
      const body = await jsonBody(request);
      if (body.replace !== undefined && typeof body.replace !== "boolean")
        throw new RequestError("replace must be true or false");
      const saved = await store.saveRecipeByName(body.name, body.recipe, body.replace === true, body.variant, body.existingLabel);
      return json(saved, saved.created ? 201 : 200);
    }
    // /api/recipes/<mealId> acts on the meal's default variant unless
    // ?variant=<id> names another; ?all=1 adds every variant's full recipe.
    const variantQuery = url.searchParams.get("variant") ?? undefined;
    if (recipePath && request.method === "GET")
      return json(store.recipe(recipePath[1], variantQuery, all));
    if (recipePath && request.method === "PUT")
      return json(await store.saveRecipe(recipePath[1], await jsonBody(request), variantQuery));
    if (recipePath && request.method === "DELETE")
      return json(await store.deleteRecipe(recipePath[1], all));
    if (variantsPath && request.method === "POST")
      return json(await store.addVariant(variantsPath[1], await jsonBody(request)), 201);
    if (variantPath && request.method === "GET")
      return json(store.recipe(variantPath[1], variantPath[2], all));
    if (variantPath && request.method === "PUT")
      return json(await store.saveRecipe(variantPath[1], await jsonBody(request), variantPath[2]));
    if (variantPath && request.method === "PATCH")
      return json(await store.updateVariant(variantPath[1], variantPath[2], await jsonBody(request)));
    if (variantPath && request.method === "DELETE")
      return json(await store.deleteVariant(variantPath[1], variantPath[2]));
    if (url.pathname === "/api/prep" && request.method === "GET") {
      const range = prepRange(
        Date.now(),
        url.searchParams.get("from"),
        url.searchParams.get("to"),
      );
      return json({
        from: kolkataIso(range.from),
        to: kolkataIso(range.to),
        reminders: await store.prep(
          range.from,
          range.to,
          url.searchParams.get("overdue") === "1",
        ),
      });
    }
    if (url.pathname === "/api/board" && request.method === "GET") {
      const week = url.searchParams.get("week") ?? undefined;
      if (
        week &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(week) ||
          !Number.isFinite(Date.parse(week + "T12:00:00Z")))
      )
        throw new Error("Invalid week");
      return json({
        ...(await store.board(week)),
        calendarUrl: current.calendarToken
          ? `${origin}/api/calendar/${current.calendarToken}.ics`
          : "",
      });
    }
    if (
      request.method === "POST" &&
      [
        "/api/change",
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
        await store.change({
          taskId: string("taskId"),
          kind,
          ...(kind === "move"
            ? { slotId: string("slotId"), date: string("date") }
            : {}),
        });
      } else if (url.pathname === "/api/settings/theme") {
        const theme = string("theme");
        if (theme !== "system" && theme !== "light" && theme !== "dark")
          throw new Error("Invalid theme");
        await store.saveTheme(theme);
      } else if (url.pathname === "/api/library/rename") {
        const aliases = fields.aliases;
        if (
          aliases !== undefined &&
          (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === "string"))
        )
          throw new Error("Invalid aliases");
        await store.renameLibrary(string("mealId"), string("name"), aliases);
      }
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
        await store.saveSlots(slots, fields.revision);
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
      await store.place(
        body as {
          requestId: string;
          mealId: string;
          slotId: string;
          date: string;
        },
      );
      return json({ ok: true });
    }
    return json({ error: "Unknown endpoint" }, 404);
  } catch (error) {
    if (error instanceof RecipeInputError)
      return json({ error: error.message, issues: error.issues }, 400);
    if (error instanceof RequestError)
      return json(
        { error: error.message, ...(error.issues ? { issues: error.issues } : {}) },
        error.status,
      );
    return json(
      { error: error instanceof Error ? error.message : "Request failed" },
      400,
    );
  }
}
const maxBodyBytes = 256 * 1024;
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBodyBytes) throw new RequestError("Request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBodyBytes)
    throw new RequestError("Request body is too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RequestError("Request body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new RequestError("Request body must be a JSON object");
  return body as Record<string, unknown>;
}
