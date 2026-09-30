import { definePrismaConfig } from "prisma/config";
import { defineConfig } from "@prisma/orm-sqlite/config";
export default definePrismaConfig({
  orm: defineConfig({
    contract: "./prisma/contract.ts",
    output: "./src/prisma",
    db: { connection: process.env.DATABASE_PATH ?? process.env.PLANNER_DB ?? "./.local/planner.sqlite" },
  }),
});
