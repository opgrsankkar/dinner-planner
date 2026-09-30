import { resolve } from "node:path";
import { definePrismaConfig } from "prisma/config";
import { defineConfig } from "@prisma/orm-sqlite/config";
// db init writes refs/snapshots here, never beside the read-only application.
// A workspace per database also isolates concurrent synthetic test databases.
const databasePath = resolve(process.env.DATABASE_PATH ?? process.env.PLANNER_DB ?? "./.local/planner.sqlite");
export default definePrismaConfig({
  orm: defineConfig({
    contract: "./prisma/contract.ts",
    output: "./src/prisma",
    db: { connection: databasePath },
    migrations: { dir: process.env.PRISMA_MIGRATIONS_DIR || `${databasePath}.prisma` },
  }),
});
