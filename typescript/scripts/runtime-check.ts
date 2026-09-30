// Run under a nonroot UID with the application mounted read-only. All data is synthetic.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.notEqual(process.getuid?.(), 0, "Acceptance must run nonroot");
const probe = resolve(`.runtime-write-probe-${randomUUID()}`);
try {
  await assert.rejects(writeFile(probe, "must fail"), /EROFS|EACCES/, "Application must be read-only");
} finally {
  await rm(probe, { force: true });
}
const directory = await mkdtemp(join(tmpdir(), "planner-runtime-"));
const password = randomUUID();
const env = {
  ...process.env,
  PRISMA_DISABLE_TELEMETRY: "1",
  PRISMA_MIGRATIONS_DIR: "",
  TODOIST_MODE: "fake", TODOIST_TOKEN: "", TODOIST_TOKEN_FILE: "",
  APP_PASSWORD: password, COOKIE_SECURE: "false",
  ALLOWED_HOSTS: "127.0.0.1", PLANNER_ORIGIN: "http://127.0.0.1:3110",
  PORT: "3110", HOST: "127.0.0.1",
  FAKE_TODOIST_DB: join(directory, "fake.sqlite"),
};
// An empty override must not redirect refs back to cwd.
delete (env as Partial<typeof env>).PRISMA_MIGRATIONS_DIR;
function cli(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  return result;
}
async function startup(db: string, expectedMeal?: string) {
  const server = spawn(process.execPath, ["scripts/serve.mjs"], {
    env: { ...env, DATABASE_PATH: db, PLANNER_DB: db }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch("http://127.0.0.1:3110/healthz")).ok; } catch {}
      if (ready || server.exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(ready, output);
    const login = await fetch("http://127.0.0.1:3110/api/login", {
      method: "POST", headers: { Origin: env.PLANNER_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const response = await fetch("http://127.0.0.1:3110/api/board", {
      headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0] },
    });
    assert.equal(response.status, 200);
    const board = await response.json();
    if (expectedMeal) assert.ok(board.library.some((meal: { name: string }) => meal.name === expectedMeal));
  } finally {
    server.kill("SIGTERM");
    if (server.exitCode === null) await new Promise<void>((done) => server.once("exit", () => done()));
  }
}
try {
  // Reproduce the old failure without relying on root build success.
  const negativeDb = join(directory, "negative.sqlite");
  const negative = cli(["node_modules/prisma/dist/prisma.js", "db", "init"], {
    DATABASE_PATH: negativeDb, PLANNER_DB: negativeDb,
    PRISMA_MIGRATIONS_DIR: resolve("migrations"),
  });
  assert.notEqual(negative.status, 0, "App-root migration refs must fail read-only");
  assert.match(negative.stdout + negative.stderr, /EACCES|EROFS/);
  const fresh = join(directory, "fresh.sqlite");
  await startup(fresh);
  assert.ok(existsSync(`${fresh}.prisma/app/refs/db.json`));
  await startup(fresh); // Existing fresh DB startup skips initialization.
  const source = join(directory, "legacy.sqlite"), target = join(directory, "imported.sqlite");
  const legacy = new DatabaseSync(source);
  legacy.exec(`CREATE TABLE meal_library(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
    CREATE TABLE meal_slots(id TEXT PRIMARY KEY,name TEXT,time TEXT,position INTEGER,time_aliases TEXT,active INTEGER);
    CREATE TABLE kv(key TEXT,value TEXT);
    CREATE TABLE idempotent_actions(request_id TEXT,kind TEXT,state TEXT,create_attempted INTEGER);
    CREATE TABLE project_task_cache(task_key TEXT,remote_id TEXT);
    CREATE TABLE task_tombstones(remote_id TEXT);
    INSERT INTO meal_slots VALUES('lunch','Lunch','13:00',0,'[]',1);
    INSERT INTO kv VALUES('theme_mode','dark');`);
  legacy.prepare("INSERT INTO meal_library VALUES(?,?,0)").run(randomUUID(), "Synthetic imported meal");
  legacy.close();
  const imported = cli(["--import", "tsx", "scripts/import-legacy.ts", "--source", source, "--target", target]);
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  await startup(target, "Synthetic imported meal");
  assert.equal(existsSync(`${target}.prisma`), false, "Imported startup skips init; staging workspace is cleaned up");
  console.log("Nonroot/read-only acceptance passed: old refs failure, fresh startup/restart, import CLI, imported startup.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
