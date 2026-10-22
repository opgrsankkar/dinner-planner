// One-off move of planned meals from the Todoist "Meals" project into the
// planner's own SQLite tables, for switching a live deployment to
// TODOIST_MODE=local. Reads active tasks plus completed history week by week.
// Re-running is safe: rows are keyed by the Todoist task ID and updated in place.
//
//   DATABASE_PATH=/data/meals.sqlite3 TODOIST_TOKEN_FILE=... \
//     node --import tsx scripts/import-todoist.ts [--from 2026-09-01] [--dry-run]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Persistence } from "../src/server/persistence";
import { TodoistApi } from "../src/server/todoist-api";
import { addDays, weekStart } from "../src/week-calendar";
import type { RemoteMeal } from "../src/types";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const from = args[args.indexOf("--from") + 1] ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error("Pass --from YYYY-MM-DD (first week to import)");
const token =
  process.env.TODOIST_TOKEN?.trim() ||
  (process.env.TODOIST_TOKEN_FILE ? readFileSync(process.env.TODOIST_TOKEN_FILE, "utf8").trim() : "");
if (!token) throw new Error("Set TODOIST_TOKEN or TODOIST_TOKEN_FILE");
if (!process.env.DATABASE_PATH) throw new Error("Set DATABASE_PATH");

// Stable UUIDs derived from the Todoist ID keep re-runs idempotent.
function uuidFor(value: string) {
  const hex = createHash("sha256").update(`meal-import:${value}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const api = new TodoistApi(token);
const project = await api.mealsProject();
const tasks = new Map<string, RemoteMeal>();
for (const task of await api.list(project.id, { fresh: true })) tasks.set(task.id, task);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
for (let week = weekStart(from); week <= weekStart(addDays(today, 7)); week = addDays(week, 7))
  for (const task of await api.list(project.id, { week, fresh: true })) tasks.set(task.id, task);

const db = new Persistence(process.env.DATABASE_PATH);
const counts = { found: tasks.size, added: 0, updated: 0, unchanged: 0, skippedUndated: 0 };
const skipped: string[] = [];
const apply = () => {
  for (const task of tasks.values()) {
    if (!task.date || !task.time) {
      counts.skippedUndated++;
      skipped.push(`${task.name} (${task.dueError || "no due time"})`);
      continue;
    }
    const id = uuidFor(task.id);
    const body = JSON.stringify({
      id, projectId: "local-meals", name: task.name, date: task.date, time: task.time,
      requestId: uuidFor(`request:${task.id}`),
    } satisfies RemoteMeal);
    const existing = db.localMealGet(id);
    if (!existing) { counts.added++; if (!dryRun) db.localMealInsert({ id, body }); }
    else if (existing.body !== body) { counts.updated++; if (!dryRun) db.localMealUpdate(id, { body }); }
    else counts.unchanged++;
  }
};
db.transaction(() => apply());
db.close();
console.log(JSON.stringify({ dryRun, ...counts, skipped }, null, 2));
