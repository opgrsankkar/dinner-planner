# Full-stack TypeScript Dinner Planner

TanStack Start/React, strict TypeScript, Node 26 and experimental Prisma ORM 8 SQLite. Todoist is the authority for planned meals. Local SQLite contains settings, reusable library, slots, sessions and a durable mutation outbox. Run one application/worker per database.

## Build and verify

```sh
export PATH=/home/hermes-admin/.hermes/cache/scratch/dinner-node/node_modules/.bin:$PATH
export TMPDIR=/home/hermes-admin/.hermes/cache/scratch
cd typescript
npm ci
npm run contract
npm test
npm run typecheck
npm run build
npm run smoke
```

The smoke starts **the actual production artifact** (`dist/server/server.js` plus `dist/client`) with `scripts/serve.mjs`, on loopback 3100. It uses fresh synthetic databases, a generated password and explicit fake mode. It exercises HTTP authentication, static assets, desktop/mobile interaction, native drag placement/move/delete, button alternatives, pending/retry/reload, settings Save/Revert/reorder, themes, completed cards, integration warnings, week navigation and logout. Browser default is `/usr/bin/google-chrome`; override `CHROME_PATH` if needed. Tests inject fetch for the real adapter; no test accesses real Todoist or deployment files.

## Production

From `typescript`, `npm run build && npm start`. The host listens on `HOST` (default `0.0.0.0`) and `PORT` (default `8789`), serves generated assets and passes application requests to TanStack Start's built fetch handler. `/healthz` is public and never initializes/calls Todoist. On a new database path, the host runs Prisma `db init`; an imported database is used directly. Database initialization failure stops startup. Graceful shutdown allows in-flight requests up to 20 seconds; pending outbox work survives restart.

The root Dockerfile builds with Node 26 and runs checks, then supplies the actual production artifact and Prisma tooling for initialization/import. Compose preserves bridge-only `172.17.0.1:8789`, host UID/GID, read-only root, writable `/data`, read-only token mount, dropped capabilities and the existing Caddy site. No domain/proxy change is needed. Hermes must verify Docker build/runtime on its Docker-enabled host.

Environment compatibility:

- `APP_PASSWORD` (legacy alias `PLANNER_PASSWORD`) is required. Sessions are random, server-side SQLite records; `SESSION_SECRET` remains accepted by Compose but is unnecessary for these opaque session IDs. Old signed cookies require a fresh login at cutover.
- `TODOIST_TOKEN` takes precedence over `TODOIST_TOKEN_FILE`. Default mode is live and missing/invalid configuration never falls back to a fake. `TODOIST_MODE=fake` is explicit offline demo/testing only; use a separate database.
- `DATABASE_PATH` (alias `PLANNER_DB`) defaults to `.local/planner.sqlite` outside Compose, `/data/meals.sqlite3` in Compose. At cutover set it to the **new imported file**, never the old Python file.
- `TZ=Asia/Kolkata`; planner dates/times are explicitly interpreted in Asia/Kolkata regardless of browser/host timezone.
- `ALLOWED_HOSTS` is a comma-separated hostname list. Without it, API uses `PLANNER_ORIGIN` (default `http://localhost:8789`). `COOKIE_SECURE=true` is used for Caddy HTTPS and sets the request protocol used by Origin checks; local HTTP tests leave it unset. No forwarded Host is trusted.

## Todoist adapter and reconciliation

The injected-fetch adapter follows [official Todoist API v1 docs](https://developer.todoist.com/api/v1/). It resolves exactly one unarchived project named `Meals`, paginates projects/active tasks (`results`) and completed history (`items`), deduplicates IDs, checks project ownership before writes, and encodes opaque task IDs. Completed history is queried **by due date for the selected week** (within the documented six-week maximum range), so a task completed on another day still appears in its scheduled cell. Completed cards cannot be edited.

Current v1 create/update schemas accept `due_datetime` but do not expose `due_timezone`. Payloads therefore use RFC3339 `+05:30`, expressing Asia/Kolkata without relying on account timezone. Responses accept v1 `due.date`, legacy `due.datetime`, zoned timestamps and India floating timestamps. Missing/invalid/unsupported floating timezone values remain visible as warnings rather than invented times. Unknown slot times appear under Other meals. Moves update only the due datetime and preserve task descriptions/content.

Every mutation preserves its UUID `X-Request-Id`. Creates also have a durable `meal-planner-request-id: UUID` description line. A create attempt is recorded **before** the request. After an uncertain network/server response or restart, the worker searches the original marker and never issues another create while the result is unknown. A known remote ID is retained before acknowledgement validation. Definitive HTTP rejections can retry the same request ID; uncertain requests remain pending with an actionable error until the original task becomes visible. Do not clear an uncertain request without inspecting its marker in Meals. DELETE success/404 is acknowledgement, with no immediate GET afterward.

Project lookup is cached for 60 seconds. Active snapshots use 15 seconds, history snapshots 60 seconds, deduplicated in-flight requests, bounded cache entries and a 15-second failure cooldown. Rate limits honor Retry-After globally. Half-second UI refresh reads cached snapshots plus local outbox overlays, not a project/task round trip each time. Combined week snapshots can take up to 60 seconds to reflect external changes. Successful create/move overlays expire after two minutes, or stop as soon as a listing confirms them; delete suppression expires after two minutes. External edits/deletions then take precedence. Failed fetches retain a bounded in-memory last snapshot and expose integration errors. The outbox survives restarts; snapshots are temporary and do not become a permanent plan database.

## Offline demo

Set `TODOIST_MODE=fake`, `APP_PASSWORD`, `PLANNER_ORIGIN=http://localhost:3000`, then `npm run demo`. Default fake data includes three example meals and slots. Live initialization uses the four legacy slot presets and an empty meal library. Fake-only optional error/delay settings: `FAKE_TODOIST_DELAY_MS`, `FAKE_TODOIST_FAIL_BEFORE`, `FAKE_TODOIST_LOSE_RESPONSE`, `FAKE_TODOIST_MOVE_FAIL_BEFORE`, `FAKE_TODOIST_DELETE_FAIL_BEFORE`. Unset failure counts when testing restart recovery.

## Legacy backup import and cutover (Hermes)

The importer never accesses a deployment path implicitly. Supply a **consistent, standalone SQLite backup** and a distinct **nonexistent** target:

```sh
npm run import:legacy -- --source /explicit/backup.sqlite --target /data/meals-typescript.sqlite
```

It opens the source read-only, checks integrity/schema and refuses unresolved pending/processing/failed actions, deletion tombstones and local optimistic cache entries. These cannot be safely converted/replayed. Leave the old worker active to drain/reconcile, inspect uncertain create markers and failed writes, wait for old tombstones to reconcile (old cleanup requires 30 minutes plus a fresh task listing), then take a new backup. Do not manually delete unresolved rows to bypass preflight. Completed receipts and ordinary remote snapshots are not imported: Todoist supplies the current plan, and no writes are replayed.

Import preserves library UUIDs/order and rejects case-insensitive duplicate names. Human-readable legacy slot IDs map deterministically to UUIDs; the full original slot IDs/order/aliases/inactive state and KV settings are retained in settings import metadata. Active slots and unambiguous aliases are applied to the new planner. Theme is preserved. A staged database transaction is closed/checkpointed and published exclusively; failure leaves no target, and rerun refuses an existing target. Tests prove byte-identical source, rollback, refusal and rerun behavior. Legacy library IDs outside the existing UUIDv4 convention require repair on a separate backup copy and are explicitly refused.

Cutover sequence: drain old actions and reconcile tombstones; retain old artifact/config and backup; stop the old mutation worker; take the final consistent backup; import into the new path; set `DATABASE_PATH`; start the new container; verify health, login, library/settings and actual scoped Todoist writes with Hermes. Never run old and new workers simultaneously. To roll back, stop the new worker and restore old artifact/config/database path. Reconcile any writes performed since cutover in Todoist before replaying old pending state. Backup files and originals remain untouched by the CLI.

## Nonroot, read-only runtime acceptance (Hermes)

Prisma `db init` writes migration refs and snapshots. `prisma.config.ts` places these in `<absolute DATABASE_PATH>.prisma` (also honoring `PLANNER_DB`), alongside the writable database, rather than `/srv/app/typescript/migrations`. A distinct database gets a distinct workspace. Import initializes inside its existing temporary staging directory, so its workspace is removed with staging; an imported database starts without initialization. Contract source and generated `src/prisma` artifacts remain read-only. `PRISMA_MIGRATIONS_DIR` can override the workspace with an explicitly writable absolute directory; leave it unset normally. Contract emission remains a build/development operation. Telemetry is disabled with `PRISMA_DISABLE_TELEMETRY=1`.

The final image includes the synthetic tests as well as init/import tooling. Run these commands without deployment secrets, live data, or the production Compose env file:

```sh
docker build -t dinner-planner:verify .
# Overrides the image UID just as Compose does; only tmpfs data/scratch are writable.
docker run --rm --read-only --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /data:rw,mode=1777,size=128m --tmpfs /tmp:rw,mode=1777,size=128m \
  -e TMPDIR=/data -e PRISMA_DISABLE_TELEMETRY=1 \
  dinner-planner:verify npm test
docker run --rm --read-only --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /data:rw,mode=1777,size=128m --tmpfs /tmp:rw,mode=1777,size=128m \
  -e TMPDIR=/data -e PRISMA_DISABLE_TELEMETRY=1 \
  dinner-planner:verify npm run check:runtime
```

`check:runtime` requires a nonroot UID and proves the app directory rejects writes. Its negative check directs refs to the read-only app directory and requires an EACCES/EROFS error. It then checks fresh production startup, authenticated fake-provider board reads, restart of that database, the actual import CLI with a synthetic legacy backup, and startup of the imported database. All fixtures and workspaces are cleaned up. No browser or real Todoist is required. The 32-test suite separately covers import rollback/refusal, source preservation, and additive initialization of an existing database.

For local Linux permission reproduction without Docker, use a fresh scratch directory with Bubblewrap (run from repository root):

```sh
runtime_scratch=$(mktemp -d /tmp/planner-readonly.XXXXXX)
bwrap --ro-bind / / --bind "$runtime_scratch" "$runtime_scratch" \
  --setenv TMPDIR "$runtime_scratch" --setenv PRISMA_DISABLE_TELEMETRY 1 \
  --chdir "$PWD/typescript" npm run check:runtime
# Repeat with npm test in place of npm run check:runtime.
```

The caller must be nonroot and use Node 26. If the agent sandbox denies piped subprocesses or loopback listeners, run these acceptance commands on Hermes's Docker-enabled host; that restriction is distinct from application filesystem permissions.

The initializer can also be reproduced directly when piped child processes are denied (same `runtime_scratch`, repository root):

```sh
bwrap --ro-bind / / --bind "$runtime_scratch" "$runtime_scratch" \
  --setenv TMPDIR "$runtime_scratch" --setenv DATABASE_PATH "$runtime_scratch/fresh.sqlite" \
  --setenv PRISMA_DISABLE_TELEMETRY 1 --chdir "$PWD/typescript" \
  node node_modules/prisma/dist/prisma.js db init
# Negative control: must fail with EROFS opening app migration refs.
bwrap --ro-bind / / --bind "$runtime_scratch" "$runtime_scratch" \
  --setenv TMPDIR "$runtime_scratch" --setenv DATABASE_PATH "$runtime_scratch/negative.sqlite" \
  --setenv PRISMA_MIGRATIONS_DIR "$PWD/typescript/migrations" \
  --setenv PRISMA_DISABLE_TELEMETRY 1 --chdir "$PWD/typescript" \
  node node_modules/prisma/dist/prisma.js db init
```

Slot drag regression and review videos (isolated synthetic SQLite and fake Todoist,
trusted Chromium CDP touch input on mobile and mouse input on desktop):

```sh
export PATH=/home/hermes-admin/.hermes/cache/scratch/dinner-node/node_modules/.bin:$PATH
export TMPDIR=/home/hermes-admin/.hermes/cache/scratch
npm run build
npm run record:slots
```

Run from `typescript/`. The script selects a free loopback port, authenticates
before recording, and asserts row/finger tracking and intermediate neighbor animation
while the drag is held. It also verifies order, Save, reload persistence, Revert, touch
cancellation preserving edited draft, page scrolling, button alternatives and input editing.
Videos use fresh timestamped `mobile-motion-slot-reorder-*.webm` and
`desktop-motion-slot-reorder-*.webm` filenames under
`/home/hermes-admin/.hermes/cache/scratch/dinner-motion-slot-videos/` (override with
`SLOT_VIDEO_DIR`; optional `SLOT_VIDEO_PORT` and `CHROME_PATH`). No live provider
or existing database is used. Videos require user review before merge/deployment.
