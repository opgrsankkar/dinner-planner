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

`npm test` runs the fresh-database Prisma smoke and the deterministic legacy compatibility harness. The migration harness extracts the exact `SCHEMA` literal from `app/db.py` with Python's AST, creates a legacy source fixture and a separate SQLite backup copy under a newly created OS temporary directory, and applies the checked-in Prisma migrations to another temporary target. It imports only from the temporary copy, opened read-only, into the empty target.

The harness proves on representative synthetic rows that:

- the six app-owned tables retain their row counts, IDs, nullable values, exact JSON text, retry values, and outbox ordering;
- `pending`, `processing`, `failed`, and `done` states survive as stored, without running the Python startup repair or retention cleanup;
- primary keys, nullable unique remote IDs, and case-insensitive meal-name uniqueness behave as expected in the target;
- a source row with a null text primary key is rejected before writing, a forced insert failure rolls the whole data-copy transaction back, and a repeat import refuses a populated target without changing it;
- cached Todoist task records remain in `project_task_cache` and no local planned-meal table is created.

Every database path in this harness is an explicit file under the fresh OS temporary root. The importer itself rejects relative paths and paths outside that root. The test never opens, copies, or writes `/data/meals.sqlite3` or any other deployment database.

## Prisma SQLite semantic blocker

Legacy `meal_library.name` is declared `TEXT NOT NULL COLLATE NOCASE UNIQUE`. Prisma ORM 8 `8.0.0-rc.13` rejects SQLite expression indexes, including `@@index(expression: "name COLLATE NOCASE", unique: true)`, with `CONTRACT.SOURCE_LOAD_FAILED`. The checked-in migration therefore uses a reviewed raw SQLite operation to recreate the unique `NOCASE` index, and the harness checks that the physical index rejects case-only duplicates. The harness also drops the index in its temporary target, confirms `prisma db verify` still reports that the schema matches, then restores it. Prisma's contract and verifier do not encode that collation rule, so future migrations cannot prove that the raw index remains present. This is a concrete cutover blocker until Prisma can represent the index or the project adopts a durable, independently verified custom invariant for every migration.

SQLite also permits null values in these legacy non-integer `TEXT PRIMARY KEY` columns despite their primary-key declarations. Prisma `@id` emits `NOT NULL`; the importer detects and rejects null source keys before it begins the transaction. App code writes non-null IDs, but a production-data audit must verify this precondition before any migration.

## What this test does not prove

The harness proves a schema-and-copy mechanism against synthetic rows and the checked-in legacy DDL. It does not read or characterize production contents, prove production row counts, resolve live outbox actions, confirm current Todoist consistency, or qualify deployment performance, locking, permissions, or filesystem behavior. It does not implement the Python startup conversions (recover `processing` as `pending`, fail old unkeyed plan actions, or prune 30-day terminal actions); the copy preserves stored states verbatim for a later explicit reconciliation decision.

Production migration remains gated on a verified backup of the exact production file, an offline read-only inventory and null-key preflight, an outbox/Todoist reconciliation plan, a rehearsed migration of a production backup, before/after count and semantic checks, a tested restore/rollback procedure with an agreed rollback point, and operational approval. No production cutover is implemented or approved by this phase.

## Roadmap

1. **Foundation:** isolated TanStack Start `/healthz`, strict TypeScript, Node 26, and a fresh temporary SQLite smoke test.
2. **Operational-state migration proof:** model legacy operational data and test a synthetic copy migration with explicit blockers and production backup/rollback gates. This phase does not qualify production data.
3. **Production runtime cutover:** a separate future phase after the contract gap, production-data audit, backup, restore, and operational-readiness gates are resolved. Todoist remains authoritative for planned meals.

## Official setup references

- [TanStack Start build from scratch](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)
- [TanStack Start server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)
- [Prisma supported databases](https://www.prisma.io/docs/orm/supported-databases)
- [Prisma SQLite extension](https://www.prisma.io/extensions/sqlite)
- [Node.js 26 downloads](https://nodejs.org/dist/v26.9.0/)
