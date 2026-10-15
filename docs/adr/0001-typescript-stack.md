# ADR 0001: TypeScript application stack

- Status: Accepted
- Date: 2026-09-29

## Context

The current planner uses FastAPI with a React frontend. This pilot records the migration direction while preserving Todoist as the authority for planned meal tasks.

## Decision

- Migrate toward a fullstack TypeScript application using TanStack Start, Node.js 26, and direct SQLite via `node:sqlite`.
- Use SQLite only for app-owned operational state, such as settings and a durable outbox. Todoist remains authoritative for planned meal tasks.

## Migration gate

The user approved replacing the experimental ORM with Node 26's built-in `node:sqlite`. Preserve existing SQLite text UUID tables in place and retain provider metadata for rollback. Schema initialization and versioning belong to the typed persistence boundary.
