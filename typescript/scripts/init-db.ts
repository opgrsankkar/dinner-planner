import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Persistence } from "../src/server/persistence";
const path = resolve(process.env.DATABASE_PATH ?? process.env.PLANNER_DB ?? ".local/planner.sqlite");
mkdirSync(dirname(path), { recursive: true });
new Persistence(path).close();
