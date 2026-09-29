# ADR 0001: TypeScript application stack

- Status: Accepted
- Date: 2026-09-29

## Context

The current planner uses FastAPI with a React frontend. This pilot records the migration direction while preserving Todoist as the authority for planned meal tasks.

## Decision

- Migrate toward a fullstack TypeScript application using TanStack Start, Node.js 26, and Prisma ORM 8.
- Use SQLite only for app-owned operational state, such as settings and a durable outbox. Todoist remains authoritative for planned meal tasks.

## Migration gate

Prisma ORM 8's current documentation labels its SQLite package experimental. Before starting runtime migration, prove that Prisma ORM 8 SQLite is compatible with the planner and that existing app-owned operational data can be migrated safely. See [Prisma ORM 8 supported databases](https://www.prisma.io/docs/orm/supported-databases).
