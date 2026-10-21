# Meal Planner

A single-user, Docker Compose meal planner backed by the Todoist project named exactly `Meals`. Todoist remains authoritative for planned meals; a durable SQLite outbox applies planner changes to Todoist in the background so drag/drop does not wait on its API.

## Standalone Docker deployment (without Todoist)

Use the standalone Compose file to store planned meals, library and settings in a
persistent SQLite volume. No Todoist account, token file or `.env` file is needed.

```sh
export APP_PASSWORD='choose-a-private-password'
docker compose -f compose.local.yaml up -d --build
```

Open `http://localhost:8789`. The container uses `TODOIST_MODE=local` and starts with
an empty library and the default meal slots. Add meals and plan them using the same
board, drag/drop, move/delete buttons and Settings. Plans survive container restarts
and rebuilds; `docker compose down -v` deletes the named data volume.

The port binds to loopback. To serve through an HTTPS reverse proxy, set
`PLANNER_ORIGIN=https://your-hostname` and `COOKIE_SECURE=true`. For a different
local port, set both `PLANNER_PORT` and `PLANNER_ORIGIN` (for example `8790` and
`http://localhost:8790`). Use a separate database/volume from a Todoist deployment;
switching modes does not import or synchronize existing plans. Local mode has no
Todoist completed-task history.

To run the image directly, mount a writable volume at `/data` and set
`TODOIST_MODE=local`, `DATABASE_PATH=/data/planner.sqlite`, `APP_PASSWORD`, and
`PLANNER_ORIGIN` to the URL you will open.

## Run

The x1c deployment uses `compose.yaml` and Caddy. Requirements:

- A Todoist API token, either `TODOIST_TOKEN` directly in `.env` or a host path in `TODOIST_TOKEN_FILE` containing only the token.
- `APP_PASSWORD` and a random `SESSION_SECRET` (the initial host setup generates these privately).

```bash
sudo systemctl enable --now homelab-dinner-planner.service
```

Open `https://meals.happydaysblr.ddns.net`. To retrieve the generated sign-in password locally on the host, run:

```bash
cd /srv/homelab/compose/dinner-planner && grep '^APP_PASSWORD=' .env
```

To use a direct token, set `TODOIST_TOKEN=...` in `.env`; it takes precedence over the token file. To use a file, leave it blank and set `TODOIST_TOKEN_FILE` to a host path containing only the API token. The file is mounted read-only and must not be committed.

## Data and behavior

- Monday–Sunday board; meal-slot rows share one global configurable list and each slot has a unique preset time.
- Initial time presets: Breakfast 08:00, Lunch 13:00, Dinner 19:00, School snack 16:00 (Asia/Kolkata). Change these in Settings.
- On phones and other screens 900px wide or narrower, the week fills the screen without vertical scrolling (slot labels stay frozen while the days scroll sideways) and the library panel is hidden: plan with the + in each cell (its dialog also has Shuffle), and manage the library in Settings → Meal library.
- Tap or click the faint + in any calendar cell (also shown in cells that already have meals) to add a meal to that day and slot: pick a library meal, or type a new name to add it to the library and plan it. Past slots are planned as already done. Drag a library meal into a dated slot to create a distinct Todoist task. Drag a planned item to another cell to update its due date/time. Completed meals (✓) can also be moved or deleted: the planner reopens the Todoist task, makes the change, and completes a moved meal again. On touch screens, tap a planned item to open its move/delete actions, or tap a library meal to plan it. Alternatively hold either for about half a second and drag: a copy follows above your finger, holding near a screen edge scrolls the board or page, and planned items can be dropped on the trash pinned to the bottom of the screen. Moving before the hold completes scrolls normally. Trash deletion still requires confirmation. Plan edits are recorded transactionally in SQLite and pushed one-way by a background worker; tiny per-meal spinner/check indicators show progress, without a page reload or global syncing banner.
- Add library names via the library search field and Add meal; Shuffle randomizes the persistent library order. Remove reusable entries from Settings → Manage meal library; this does not delete existing Todoist placements.
- Appearance starts in `system` mode. The plan-page toggle switches to the opposite of the current effective system/light/dark theme; Settings offers System, Light, and Dark so you can reset to system.
- Completed task history is read from Todoist where available. SQLite keeps durable outbox receipts; bounded temporary snapshots and optimistic overlays are reconciled with Todoist—not a separate permanent plan history. Undated and invalid-time tasks are reported as warnings.
- Slot-time edits migrate active Meals tasks from the old preset time to the new one. The setting remains classifiable if a Todoist write is temporarily incomplete; the error is shown and a retry can finish the migration.
- A missing/ambiguous Meals project, API error, missing due time, or unknown preset never silently becomes a local plan. The board displays integration errors or a warning.

## Security and storage

- Single shared password, server-side opaque HttpOnly/Secure/SameSite session, throttled login, CSRF checks, trusted-host validation, security headers, and server-only Todoist token.
- The web process runs non-root using the host UID/GID from `.env` so it can read a mode-0600 token file and write private bind-mounted data. It drops Linux capabilities and binds only to `172.17.0.1:8789` for Caddy.
- SQLite lives at `DATABASE_PATH` (default `/data/meals.sqlite3`); `/data` is the persistent host bind mount. Unsent actions survive app/container restarts, retry with backoff, and expose a small per-meal retry control after repeated failure. A successful Todoist DELETE response is treated as the acknowledgement; the app does not immediately GET the deleted task, avoiding false “still exists” errors from stale reads.
- Local Lucide SVG icons are served from the app itself; no third-party icon CDN or runtime font dependency is needed.
- Copy `.env.example` to `.env` only for a fresh manual deployment. Never commit `.env`, `secrets/`, or `data/`.

## TypeScript application

The root container now builds and hosts TanStack Start/React with Node 26 and direct SQLite via `node:sqlite`. See [implementation, verification and cutover instructions](typescript/README.md). The Python source remains only as a behavior/data reference and rollback artifact; never point the new runtime at the old Python database. Import an explicit backup into a distinct target and set `DATABASE_PATH` to it.

## Local checks

```bash
cd app/frontend && npm ci && npm run build
cd ../..
python -m pytest app/tests -q
sudo docker compose -f compose.yaml config -q
sudo docker compose -f compose.yaml build
sudo docker build --target test -t dinner-planner-test . # App tests in-image; host-only scheduler integration is covered by pytest above.
```
