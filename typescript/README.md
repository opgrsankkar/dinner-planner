# Full-stack TypeScript Dinner Planner

TanStack Start/React, strict TypeScript, Node 26 and direct SQLite via `node:sqlite`. SQLite holds everything: planned meals, the reusable library, slots, settings and recipes. Run one application per database.

## How a change is saved

Each change is one SQLite transaction made while the request is handled; the response means it is saved. There is no queue or background worker.

- **Plan a meal** (`POST /api/plan`): the browser's request ID becomes the planned meal's id, so repeating the request after a lost response finds the meal already there.
- **Move** (`POST /api/change`, `kind: "move"`): sets the meal's date and slot time; repeating it changes nothing. Moving a meal that no longer exists answers 404.
- **Delete** (`kind: "delete"`): deleting a meal that is already gone succeeds.
- **Slot times** (`POST /api/settings/slots`): meals still to come follow their slot to its new time; eaten meals keep their time and find their slot through an alias.

The browser keeps the save state. A card shows a spinner while its request is in flight and a check for two seconds after it is answered. A failed request keeps the card with a retry button that resends the same request ID. Requests whose answer never arrived, for example because the page was reloaded, are kept in `sessionStorage` and sent again on the next load.

A meal counts as eaten (completed) once its date and slot time have passed. This is worked out on every read, never stored.

## Build and verify

```sh
cd typescript
npm ci
npm test
npm run typecheck
npm run build
npm run smoke:local   # production server: create/move/delete, replay, restart
npm run smoke:drag    # browser: drag, tap-hold copy, keyboard alternative, cross-week moves
npm run smoke:pwa     # browser: installability and offline page
```

The smokes start **the actual production artifact** (`dist/server/server.js` plus `dist/client`) with `scripts/serve.mjs` against a fresh temporary database. The browser smokes use Playwright's Chromium. No test reads deployment files.

## Production

From `typescript`, run `npm run build && npm start`. The host listens on `HOST` (default `0.0.0.0`) and `PORT` (default `8789`), serves the generated assets and passes application requests to TanStack Start's built fetch handler. `/healthz` is public. Database initialization failure stops startup. Graceful shutdown allows in-flight requests up to 20 seconds.

The root Dockerfile builds with Node 26 and runs the checks, then ships only the production artifact and production dependencies. Compose keeps the bridge-only `172.17.0.1:8789` port, host UID/GID, read-only root, writable `/data` and dropped capabilities.

Environment:

- There is no login; Caddy's LAN/tailnet gate controls access. `APP_PASSWORD`, `SESSION_SECRET` and any `TODOIST_*` settings are ignored if still present.
- `ICS_TOKEN` (20+ URL-safe characters) enables the read-only calendar feed at `/api/calendar/<ICS_TOKEN>.ics`. Settings → Calendar shows the full link.
- `DATABASE_PATH` (alias `PLANNER_DB`) defaults to `.local/planner.sqlite` outside Compose and `/data/meals.sqlite3` in Compose.
- `PLANNER_DEMO=1` seeds three sample meals into an empty database (`npm run demo` sets it).
- `TZ=Asia/Kolkata`. Planner dates and times are always interpreted in Asia/Kolkata, whatever the browser or host timezone.
- `ALLOWED_HOSTS` is a comma-separated hostname list. Without it, the API uses `PLANNER_ORIGIN` (default `http://localhost:8789`). An `https:` `PLANNER_ORIGIN` (or the older `COOKIE_SECURE=true`) sets the protocol used by Origin checks behind Caddy. No forwarded Host is trusted.

## Schema

The `Persistence` constructor creates missing tables and migrates by `PRAGMA user_version` in one transaction. A newer version than the build knows fails closed.

- **Version 1** adopted the original text-UUID tables in place.
- **Version 2** turned one-recipe-per-meal into recipe variants.
- **Version 3** (November 2026) removed the Todoist-era write path:
  - planned meals moved from JSON bodies in `local_meal` into the `planned_meal` table, keeping their ids, which are the calendar feed's UIDs;
  - the `outbox`, `local_receipt` and `session` tables were dropped;
  - before migrating, a copy of the database is written beside it as `<db>.pre-v3`, and an older build refuses a v3 database, so that copy plus the previous build is the rollback;
  - the migration logs `local_meal N → planned_meal N` and any unsaved outbox rows it dropped.

Until November 2026 the planner kept meals in a Todoist project and later behind a Todoist-shaped outbox and worker. That code is in git history before schema version 3.
