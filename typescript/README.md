# TypeScript vertical slice (offline)

This directory is a fresh TanStack Start/React implementation based on current master behavior. It does not change the deployed Python application, root Dockerfile, Compose configuration, existing data, or Todoist. All provider calls use a persistent fake Todoist database, separate from the planner database. No live provider adapter is installed.

Use Node **26.10.0** (Node 26 required). The implementation session selected it in `/tmp/dinner-node/node_modules/.bin`; that temporary installation is not a deployment dependency. To install it without sudo in user-owned project tooling:

```sh
npm --cache /tmp/dinner-npm install --prefix /tmp/dinner-node node@26.10.0
export PATH=/tmp/dinner-node/node_modules/.bin:$PATH
cd /home/hermes-admin/Projects/dinner-planner/typescript
npm ci
```

Set a password without putting it in shell history or logs, then start the offline demo:

```sh
read -r -s -p 'Demo password: ' PLANNER_PASSWORD; printf '\n'
export PLANNER_PASSWORD
npm run demo
```

Open **http://localhost:3000**. Sign in with the password you set. Demo startup initializes the Prisma database idempotently and starts Vite/TanStack Start on loopback port 3000. Use only one application process per planner database. Stop with Ctrl+C and run the same command again to resume pending writes. The default files are `.local/planner.sqlite` (operational state) and `.local/fake-todoist.sqlite` (fake remote authority), both ignored by Git. They are entirely separate from the Python `data/` directory.

Optional offline scenarios, set before startup:

```sh
export FAKE_TODOIST_DELAY_MS=4000       # spinner stays visible across reload
export FAKE_TODOIST_FAIL_BEFORE=2       # first two creates fail before writing
export FAKE_TODOIST_LOSE_RESPONSE=1     # first create writes, then loses its response
npm run demo
```

Failure counts reset on process restart, so unset them before restarting if you want recovery immediately. `PLANNER_DB` and `FAKE_TODOIST_DB` may point to other synthetic files; initialize the planner with `npm run db:init` using the same environment. `PLANNER_ORIGIN` defaults to `http://localhost:3000`; set it to the exact browser origin when changing the port or serving HTTPS. HTTPS uses a Secure session cookie. No forwarded-host headers are trusted.

## Implemented behavior

- Password login, SQLite sessions with seven-day expiry, server-side logout, HttpOnly/SameSite cookies, strict host and mutation Origin checks, session CSRF tokens, bounded login attempts. The password stays server-side in the environment.
- Weekly board, preset Breakfast/Lunch/Dinner slots, reusable library addition/search, active provider meal cards, week navigation and This week.
- Library drag placement and keyboard/touch Plan dialog. Existing CSS, icon assets, small spinner/check feedback and light/dark/system themes are reused. Theme choice persists in the browser and follows system changes.
- Placement snapshots the library meal and slot into a durable outbox transaction. Request IDs are UUIDs and unique primary keys. Repeated identical submissions reuse the operation; conflicting reuse is rejected.
- Pending cards are temporary projections of outbox intent. Confirmed cards come from the provider, not saved outbox rows. A background worker validates Meals project ownership and the create acknowledgement before marking an operation saved. A check appears for two seconds, then disappears.
- Failed operations stay pending with their error and exponential automatic retries capped at 30 seconds. The worker searches the placement request marker before create and preserves the original request ID on every attempt. The injectable provider contract requires idempotent create by request ID; the fake enforces this in its own durable SQLite table.
- Lost browser acknowledgements retain the exact submission in sessionStorage for reload and explicit retry. Definitive HTTP rejection removes the temporary local card. Once the server exposes an operation, the durable server outbox takes over.

## Verification

```sh
npm ci
npm run contract
npm test
npm run typecheck
npm run build
npm run smoke
```

Tests initialize new synthetic Prisma databases under `/tmp`; they never read Python data or call Todoist. They prove restart durability, rollback, repeated/concurrent request idempotency, recovery after uncertain create, retry after pre-write failure, project ownership, provider authority, session expiry/logout, CSRF and Origin/host rejection. `npm run smoke` launches an isolated demo on **3100**, uses a randomly generated password without printing it, runs HTTP and desktop/mobile browser interactions, then cleans up. It uses `/usr/bin/google-chrome`; set `CHROME_PATH` to another installed Chromium executable if necessary.

The production build emits `dist/client` and `dist/server/server.js`. Production Node hosting/container integration and deployment are deliberately outside this milestone; use the development command above to run this slice.

## Current package compatibility

Pinned packages and lockfile use Prisma ORM SQLite `8.0.0-rc.14`, Prisma CLI `8.0.0-rc.19`, TanStack Start `1.168.59`, React `19.3.0`, Vite `8.3.1`, and TypeScript `5.9.3`. Prisma CLI bundles toolchain `rc.13`; an explicit override aligns it to SQLite's `rc.14`. Without that alignment, contract emission fails with `CONTRACT.PACK_CONTRIBUTION_INVALID` (malformed `enum` authoring contribution). Contract emission and SQLite initialization work with the override.

Current primary references consulted: [Prisma 8 SQLite runtime/config](https://www.prisma.io/extensions/sqlite), [Prisma SQLite example](https://github.com/prisma/orm/tree/main/examples/prisma-8-demo-sqlite), [TanStack Start setup](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch). Installed package type declarations were also checked for the pinned API.

`npm audit` currently reports 13 findings (5 moderate, 8 high), predominantly through Prisma CLI/Composer dependencies. Audit's proposed direct Prisma fix downgrades to 7.10.0, which violates the required stack. These need upstream review before eventual deployment; no downgrade or forced upgrade was applied.

## Subsequent slices

Move/delete, manual retry controls for server outbox operations, slot/library management, settings Save/Revert, server-owned theme settings, history/reconciliation, live Todoist adapter, operational data migration, production hosting and deployment remain unimplemented. A real Todoist adapter must preserve stable `X-Request-Id` and a durable task description marker, resolve a scoped Meals project, and handle uncertain creates without duplicate writes; do not substitute an in-memory successful response. Future delete must treat success/404 as acknowledgement without an immediate GET.
