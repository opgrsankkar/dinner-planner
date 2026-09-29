# TypeScript migration foundation

This directory is an isolated first milestone for the Dinner Planner migration. It uses the official TanStack Start React setup, Node.js 26, Prisma ORM 8, and the documented experimental SQLite package. The existing Python app, React UI, Docker deployment, and runtime remain in place and are not integrated with this project.

## Data ownership

Todoist remains authoritative for planned meal tasks. The existing application also keeps operational state locally, including settings, cached task state, tombstones, and a durable outbox for Todoist writes. This milestone models only a small key/value operational setting; it does not import or copy existing data and does not model planned meals as locally authoritative records.

## Commands

Use Node.js 26:

```sh
npm ci
npm run prisma:emit
npm run prisma:plan
npm run prisma:migrate -- --db ./operational.sqlite3
npm run typecheck
npm run build
npm run test:sqlite
```

Run `npm run dev` to exercise `/healthz`, which responds with `{"status":"ok"}`. This milestone does not add a production server adapter or connect the isolated build to the existing deployment.

`test:sqlite` applies the checked-in migration to a newly created database under the operating system temporary directory, writes and reads one operational setting, then removes the temporary directory. It never reads `/data/meals.sqlite3`.

Prisma's current documentation labels its SQLite package experimental. Passing this isolated spike is only an initial compatibility signal, not production qualification.

## Roadmap and gates

1. **Foundation (this milestone):** isolated TanStack Start `/healthz`, strict TypeScript, Node 26, a minimal operational setting, and a fresh temporary-database Prisma SQLite validate/generate/migrate/read/write spike.
2. **Future gate — compatibility and operational-data migration proof:** establish Prisma 8 SQLite compatibility for the real operational schema and prove a safe, repeatable migration of settings, cache/tombstone state, and durable outbox semantics from an application-owned data copy. Define backup, rollback, and consistency checks. No production-data migration proof is claimed here.
3. **Future gate — production runtime cutover:** only after the prior gate and explicit deployment/operational readiness, plan a separate cutover. Keep Todoist authoritative for planned meal tasks. This milestone does not perform or authorize a runtime cutover.

## Official setup references

- [TanStack Start build from scratch](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)
- [TanStack Start server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)
- [Prisma supported databases](https://www.prisma.io/docs/orm/supported-databases)
- [Prisma SQLite extension](https://www.prisma.io/extensions/sqlite)
- [Node.js 26 downloads](https://nodejs.org/dist/v26.9.0/)
