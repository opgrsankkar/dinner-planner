# ADR 0001: TypeScript application stack

- Status: Accepted
- Date: 2026-09-29

## Context

The current planner uses FastAPI with a React frontend. This pilot records the direction for its migration while preserving Todoist as the authority for planned meal tasks.

## Decision

- Migrate toward a fullstack TypeScript application using TanStack Start, running on Node.js 26 and Prisma ORM 8.
- SQLite is acceptable for app-owned operational state, including settings and a durable outbox. Todoist remains authoritative for planned meal tasks.

## Risk and migration gate

Prisma ORM 8's current documentation labels its SQLite package experimental. Prove SQLite compatibility and the migration path for the planner's operational data before relying on Prisma ORM 8 with SQLite. This proof is a gate for the migration, not an assumption of this pilot. See [Prisma ORM 8 supported databases](https://www.prisma.io/docs/orm/supported-databases).
