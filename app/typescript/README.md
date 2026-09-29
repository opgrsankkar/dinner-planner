# TypeScript migration foundation

This is an isolated Dinner Planner migration project using TanStack Start, Node.js 26, Prisma ORM 8, and the experimental Prisma SQLite package. It is not wired to the deployed application. The Python and React runtimes, deployment files, and services remain outside this migration phase.

## Data ownership and contract

Todoist remains authoritative for planned meals. The SQLite contract has no `planned_meals` model. `project_task_cache` stores only an ephemeral cache of Todoist responses; tombstones suppress recently deleted remote tasks. The other owned data is the reusable meal library, configurable meal slots, key/value settings, and durable `idempotent_actions` outbox rows.

The contract maps all six tables and their stored columns. Outbox `state` remains unrestricted text so `pending`, `processing`, `failed`, and `done` rows, retry counts/timestamps, errors, remote IDs, request IDs, payload JSON text, and response JSON text can be copied without reinterpretation. The migration also preserves cache JSON, local cache keys with null remote IDs, tombstones, slot aliases, inactive slots, settings, and legacy row order (used by outbox FIFO selection).

## Commands

Use Node.js 26 and the checked-in lockfile:

```sh
npm ci
npm run prisma:emit
npm run prisma:plan -- --from 4de5b1e9dbd30bde4f9d75b24eaef329b9fbf6914fdfa951e90ff5595442d407
npm run prisma:migrate -- --db ./operational.sqlite3
npm test
npm run typecheck
npm run build
```

## TypeScript authentication/security foundation

The TypeScript server requires `APP_PASSWORD` and a `SESSION_SECRET` with at least 32 characters. `ALLOWED_HOSTS` is a comma-separated list of hostnames (optionally with ports); it defaults to the Python app's current host list and rejects empty or malformed entries. Secure cookies are enabled by default. Setting `COOKIE_SECURE=false` is intended only for isolated local tests over HTTP.

The `/login` page is server-rendered and accessible. Successful sign-in sets a signed, 30-day `HttpOnly; SameSite=Lax` cookie, with `Secure` and the `__Host-` prefix when secure cookies are enabled. Protected pages redirect unauthenticated requests to login; `/api` and TanStack server-function requests return JSON 401 responses. Logout and non-read requests require same-origin request metadata; logout also verifies the session CSRF token. Response security headers apply to app pages and APIs, which use `Cache-Control: no-store`. `/healthz` is public and returns a static status without a Todoist client call.

Login throttling allows five failed attempts per client IP in a rolling five-minute window. In the Fetch request model, the resolver reads `CF-Connecting-IP`, then the first `X-Forwarded-For` address, then `X-Real-IP`; a reverse proxy must replace or sanitize these headers before forwarding requests. Authentication tests use explicit in-memory test configuration and temporary files where needed. They do not load deployment secrets or databases.

This milestone adds only the authentication and security foundation under `src/security`, `/login`, `/logout`, and the small authenticated landing page. It does not add planner/settings routes, Todoist calls, or an outbox, and it does not modify the Python/React runtime or deployment configuration.

`npm test` runs the authentication unit tests, built-server HTTP integration tests, a fresh-database Prisma smoke, the meal-library invariant verifier cases, and the deterministic legacy compatibility harness. All migration tests and smokes apply Prisma migrations through the supported wrapper. The legacy compatibility harness extracts the exact `SCHEMA` literal from `app/db.py` with Python's AST, creates a legacy source fixture and a separate SQLite backup copy under a newly created OS temporary directory, and applies the checked-in Prisma migrations to another temporary target. It imports only from the temporary copy, opened read-only, into the empty target.

The harness proves on representative synthetic rows that:

- the six app-owned tables retain their row counts, IDs, nullable values, exact JSON text, retry values, and outbox ordering;
- `pending`, `processing`, `failed`, and `done` states survive as stored, without running the Python startup repair or retention cleanup;
- primary keys, nullable unique remote IDs, and case-insensitive meal-name uniqueness behave as expected in the target;
- a source row with a null text primary key is rejected before writing, a forced insert failure rolls the whole data-copy transaction back, and a repeat import refuses a populated target without changing it;
- cached Todoist task records remain in `project_task_cache` and no local planned-meal table is created.

Every database path in the migration harness is an explicit file under its fresh OS temporary root. The importer itself rejects relative paths and paths outside that root. The tests never open, copy, or write `/data/meals.sqlite3` or any other deployment database.

## Meal-library uniqueness invariant

Legacy `meal_library.name` is declared `TEXT NOT NULL COLLATE NOCASE UNIQUE`. The locked Prisma SQLite package `@prisma/orm-sqlite@8.0.0-rc.13` cannot represent this collation-specific unique index in its contract, so the checked-in migration retains a reviewed raw SQLite operation that creates `meal_library_name_nocase`. This operation is intentionally unchanged. The locked `prisma@8.0.0-rc.18` CLI supports `prisma db migrate --db <url>`; the wrapper calls that command with the required explicit database path.

Use the supported wrapper for every migration:

```sh
npm run prisma:migrate -- --db ./operational.sqlite3
```

The wrapper requires an explicit `--db <path>`, applies `prisma db migrate` to that path, then runs the custom invariant verifier. The verifier opens an existing database read-only and checks SQLite's physical metadata for the `meal_library` table, its visible non-null `TEXT` `name` column, and exactly one non-partial unique `meal_library_name_nocase` index on that column with `NOCASE` collation. It checks `sqlite_schema`, `PRAGMA table_list`, `PRAGMA table_xinfo`, `PRAGMA index_list`, and `PRAGMA index_xinfo`; it does not infer the invariant from the saved SQL text.

The contract gap is demonstrated by the temporary tests: after the custom index is dropped, Prisma ORM `8.0.0-rc.13` `prisma db verify --db <path>` still succeeds, while the custom verifier and migration wrapper fail. Raw Prisma migration or verification commands alone therefore do not establish migration readiness. The wrapper is the supported migration command and must succeed before a database is considered ready under this invariant.

## Separate importer preflight

SQLite permits null values in legacy non-integer `TEXT PRIMARY KEY` columns despite their primary-key declarations. Prisma `@id` emits `NOT NULL`; the importer separately detects and rejects null source keys before beginning its transaction. This is an importer check, not part of the meal-library invariant verifier. Imported values are copied as stored and are not normalized. Any production-data audit must independently verify the null-key precondition before migration.

## What this test does not prove

The harness proves a schema-and-copy mechanism against synthetic rows and the checked-in legacy DDL. It does not read or characterize production contents, prove production row counts, resolve live outbox actions, confirm current Todoist consistency, or qualify deployment performance, locking, permissions, or filesystem behavior. It does not implement the Python startup conversions (recover `processing` as `pending`, fail old unkeyed plan actions, or prune 30-day terminal actions); the copy preserves stored states verbatim for a later explicit reconciliation decision.

Production migration remains gated on a verified backup of the exact production file, an offline read-only inventory and null-key preflight, an outbox/Todoist reconciliation plan, a rehearsed migration of a production backup, before/after count and semantic checks, a tested restore/rollback procedure with an agreed rollback point, and operational approval. No production cutover is implemented or approved by this phase.

## Roadmap

1. **Foundation:** isolated TanStack Start `/healthz`, strict TypeScript, Node 26, and a fresh temporary SQLite smoke test.
2. **Operational-state migration proof:** model legacy operational data and test a synthetic copy migration with an explicit custom check for the raw SQLite collation invariant and production backup/rollback gates. This phase does not qualify production data.
3. **TypeScript authentication/security:** port the existing password, signed-session, host validation, CSRF, rate-limit, and response-header foundation into the isolated TypeScript app.
4. **Production runtime cutover:** a separate future phase after the production-data audit, backup, restore, and operational-readiness gates are resolved. Todoist remains authoritative for planned meals.

## Official setup references

- [TanStack Start build from scratch](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)
- [TanStack Start server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)
- [TanStack Start server entry point](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point)
- [TanStack Start middleware and CSRF protection](https://tanstack.com/start/latest/docs/framework/react/guide/middleware)
- [TanStack Start authentication](https://tanstack.com/start/latest/docs/framework/react/guide/authentication)
- [Prisma supported databases](https://www.prisma.io/docs/orm/supported-databases)
- [Prisma SQLite extension](https://www.prisma.io/extensions/sqlite)
- [Node.js 26 downloads](https://nodejs.org/dist/v26.9.0/)
