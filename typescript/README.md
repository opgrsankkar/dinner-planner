# Full-stack TypeScript Dinner Planner

TanStack Start/React, strict TypeScript, Node 26 and direct SQLite via `node:sqlite`. The deployment runs `TODOIST_MODE=local`, where SQLite holds planned meals as well as settings, reusable library, slots and a durable mutation outbox. Run one application/worker per database.

In `TODOIST_MODE=local` the same board and outbox worker operate on durable SQLite
`local_meal`/`local_receipt` tables. Writes and replay receipts commit together; no
Todoist requests or token-file reads occur. Completion is derived from the clock: a
meal is done once its date and slot time have passed. `scripts/import-todoist.ts`
copies an existing Todoist Meals project (active and completed history) into these
tables before switching a deployment to local mode.

## Build and verify

```sh
export PATH=/home/hermes-admin/.hermes/cache/scratch/dinner-node/node_modules/.bin:$PATH
export TMPDIR=/home/hermes-admin/.hermes/cache/scratch
cd typescript
npm ci
npm test
npm run typecheck
npm run build
npm run smoke
npm run smoke:local
```

The smoke starts **the actual production artifact** (`dist/server/server.js` plus `dist/client`) with `scripts/serve.mjs`, on loopback 3100. It uses fresh synthetic databases and explicit fake mode. It exercises static assets, desktop/mobile interaction, native drag placement/move/delete, button alternatives, pending/retry/reload, settings Save/Revert/reorder, themes, completed cards, integration warnings, week navigation and the Calendar settings panel. Browser default is `/usr/bin/google-chrome`; override `CHROME_PATH` if needed. Tests inject fetch for the real adapter; no test accesses real Todoist or deployment files.

## Production

From `typescript`, `npm run build && npm start`. The host listens on `HOST` (default `0.0.0.0`) and `PORT` (default `8789`), serves generated assets and passes application requests to TanStack Start's built fetch handler. `/healthz` is public and never initializes/calls Todoist. The persistence constructor initializes missing tables and adopts existing text UUID tables in place using schema version 1. Database initialization failure stops startup. Graceful shutdown allows in-flight requests up to 20 seconds; pending outbox work survives restart.

The root Dockerfile builds with Node 26 and runs checks, then supplies the actual production artifact and production dependencies only. Compose preserves bridge-only `172.17.0.1:8789`, host UID/GID, read-only root, writable `/data`, dropped capabilities and the existing Caddy site. No domain/proxy change is needed. Hermes must verify Docker build/runtime on its Docker-enabled host.

Environment compatibility:

- There is no login; `APP_PASSWORD`/`SESSION_SECRET` are ignored if still present. Access control is Caddy's LAN/tailnet gate.
- `ICS_TOKEN` (20+ URL-safe characters) enables the read-only calendar feed at `/api/calendar/<ICS_TOKEN>.ics`; Settings → Calendar shows the full link.
- `TODOIST_TOKEN` takes precedence over `TODOIST_TOKEN_FILE`. Default mode is live and missing/invalid configuration never falls back to a fake. `TODOIST_MODE=fake` is explicit offline demo/testing only; use a separate database.
- `TODOIST_MODE=local` requires no Todoist credentials and ignores any configured token/token file. New local databases have an empty library and the four default slots. Planned meals persist in SQLite; completed history from Todoist is unavailable.
- `DATABASE_PATH` (alias `PLANNER_DB`) defaults to `.local/planner.sqlite` outside Compose, `/data/meals.sqlite3` in Compose. At cutover set it to the **new imported file**, never the old Python file.
- `TZ=Asia/Kolkata`; planner dates/times are explicitly interpreted in Asia/Kolkata regardless of browser/host timezone.
- `ALLOWED_HOSTS` is a comma-separated hostname list. Without it, API uses `PLANNER_ORIGIN` (default `http://localhost:8789`). An `https:` `PLANNER_ORIGIN` (or the older `COOKIE_SECURE=true`) sets the request protocol used by Origin checks behind Caddy; local HTTP tests use an `http:` origin. No forwarded Host is trusted.

## Todoist adapter and reconciliation

The injected-fetch adapter follows [official Todoist API v1 docs](https://developer.todoist.com/api/v1/). It resolves exactly one unarchived project named `Meals`, paginates projects/active tasks (`results`) and completed history (`items`), deduplicates IDs, checks project ownership before writes, and encodes opaque task IDs. Completed history is queried **by due date for the selected week** (within the documented six-week maximum range), so a task completed on another day still appears in its scheduled cell. Completed cards cannot be edited.

Current v1 create/update schemas accept `due_datetime` but do not expose `due_timezone`. Payloads therefore use RFC3339 `+05:30`, expressing Asia/Kolkata without relying on account timezone. Responses accept v1 `due.date`, legacy `due.datetime`, zoned timestamps and India floating timestamps. Missing/invalid/unsupported floating timezone values remain visible as warnings rather than invented times. Unknown slot times appear under Other meals. Moves update only the due datetime and preserve task descriptions/content.

Every mutation preserves its UUID `X-Request-Id`. Creates also have a durable `meal-planner-request-id: UUID` description line. A create attempt is recorded **before** the request. After an uncertain network/server response or restart, the worker searches the original marker and never issues another create while the result is unknown. A known remote ID is retained before acknowledgement validation. Definitive HTTP rejections can retry the same request ID; uncertain requests remain pending with an actionable error until the original task becomes visible. Do not clear an uncertain request without inspecting its marker in Meals. DELETE success/404 is acknowledgement, with no immediate GET afterward.

Project lookup is cached for 60 seconds. Active snapshots use 15 seconds, history snapshots 60 seconds, deduplicated in-flight requests, bounded cache entries and a 15-second failure cooldown. Rate limits honor Retry-After globally. Half-second UI refresh reads cached snapshots plus local outbox overlays, not a project/task round trip each time. Combined week snapshots can take up to 60 seconds to reflect external changes. Successful create/move overlays expire after two minutes, or stop as soon as a listing confirms them; delete suppression expires after two minutes. External edits/deletions then take precedence. Failed fetches retain a bounded in-memory last snapshot and expose integration errors. The outbox survives restarts; snapshots are temporary and do not become a permanent plan database.

## Offline demo

Set `TODOIST_MODE=fake`, `PLANNER_ORIGIN=http://localhost:3000`, then `npm run demo`. Default fake data includes three example meals and slots. Live initialization uses the four legacy slot presets and an empty meal library. Fake-only optional error/delay settings: `FAKE_TODOIST_DELAY_MS`, `FAKE_TODOIST_FAIL_BEFORE`, `FAKE_TODOIST_LOSE_RESPONSE`, `FAKE_TODOIST_MOVE_FAIL_BEFORE`, `FAKE_TODOIST_DELETE_FAIL_BEFORE`. Unset failure counts when testing restart recovery.

## Legacy backup import and cutover (Hermes)

The importer never accesses a deployment path implicitly. Supply a **consistent, standalone SQLite backup** and a distinct **nonexistent** target:

```sh
npm run import:legacy -- --source /explicit/backup.sqlite --target /data/meals-typescript.sqlite
```

It opens the source read-only, checks integrity/schema and refuses unresolved pending/processing/failed actions, deletion tombstones and local optimistic cache entries. These cannot be safely converted/replayed. Leave the old worker active to drain/reconcile, inspect uncertain create markers and failed writes, wait for old tombstones to reconcile (old cleanup requires 30 minutes plus a fresh task listing), then take a new backup. Do not manually delete unresolved rows to bypass preflight. Completed receipts and ordinary remote snapshots are not imported: Todoist supplies the current plan, and no writes are replayed.

Import preserves library UUIDs/order and rejects case-insensitive duplicate names. Human-readable legacy slot IDs map deterministically to UUIDs; the full original slot IDs/order/aliases/inactive state and KV settings are retained in settings import metadata. Active slots and unambiguous aliases are applied to the new planner. Theme is preserved. A staged database transaction is closed/checkpointed and published exclusively; failure leaves no target, and rerun refuses an existing target. Tests prove byte-identical source, rollback, refusal and rerun behavior. Legacy library IDs outside the existing UUIDv4 convention require repair on a separate backup copy and are explicitly refused.

Cutover sequence: drain old actions and reconcile tombstones; retain old artifact/config and backup; stop the old mutation worker; take the final consistent backup; import into the new path; set `DATABASE_PATH`; start the new container; verify health, login, library/settings and actual scoped Todoist writes with Hermes. Never run old and new workers simultaneously. To roll back, stop the new worker and restore old artifact/config/database path. Reconcile any writes performed since cutover in Todoist before replaying old pending state. Backup files and originals remain untouched by the CLI.

## Nonroot, read-only runtime acceptance (Hermes)

Schema initialization uses direct `node:sqlite` statements and writes only to the selected database. No generated contracts or migration workspace is required. Run `npm run check:runtime` from the full build/test checkout (the slim runtime omits developer tools) under a nonroot, read-only application mount with writable data and temporary directories to verify fresh/restarted/imported startup.

Schema version 1 creates missing application tables and sets `PRAGMA user_version=1` in one transaction. Existing table names, text UUID IDs, columns and values are preserved, including outbox, settings, sessions and local replay receipts. Existing provider metadata is untouched. Future versions fail closed. Keep a consistent SQLite backup and the old artifact before cutover; restore the backup if subsequent writes must be undone. Run only one mutation worker during cutover.
