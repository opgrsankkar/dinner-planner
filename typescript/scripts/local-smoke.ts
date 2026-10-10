import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "../src/types";

const directory = await mkdtemp(join(tmpdir(), "planner-local-runtime-"));
const origin = "http://127.0.0.1:3197";
const env = {
  ...process.env, TODOIST_MODE: "local", APP_PASSWORD: randomUUID(),
  DATABASE_PATH: join(directory, "planner.sqlite"), PLANNER_ORIGIN: origin,
  HOST: "127.0.0.1", PORT: "3197", COOKIE_SECURE: "false",
  ALLOWED_HOSTS: "127.0.0.1", TODOIST_TOKEN: "",
  // Proves local mode does not read a token even when a file is configured.
  TODOIST_TOKEN_FILE: join(directory, "nonexistent-token"),
};
let server: ReturnType<typeof spawn> | undefined;
let output = "";
let cookie = "", csrf = "";
async function start() {
  output = "";
  server = spawn(process.execPath, ["scripts/serve.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", chunk => { output += chunk; });
  server.stderr!.on("data", chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin + "/healthz")).ok) return; } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local startup failed: ${output}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  await new Promise<void>(resolve => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}
async function request(path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "x-csrf-token": csrf, origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
async function board(): Promise<Board> { return (await request("/api/board?week=2026-10-12")).json(); }
async function saved(requestId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = await board();
    if (current.receivedRequests.includes(requestId) && current.cards.length &&
        current.cards.every(card => card.state === "saved")) return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Local write did not complete");
}
try {
  await start();
  assert.equal((await fetch(origin + "/api/board")).status, 401);
  const login = await request("/api/login", { password: env.APP_PASSWORD });
  cookie = login.headers.get("set-cookie")!;
  const initial = await board();
  csrf = initial.csrf;
  assert.equal(initial.integrationError, "");
  assert.equal(initial.library.length, 0);
  const meal = await (await request("/api/library", { name: "Standalone dinner" })).json();
  const placement = { requestId: randomUUID(), mealId: meal.id, slotId: initial.slots[0].id, date: "2026-10-12" };
  await request("/api/plan", placement);
  const placed = await saved(placement.requestId);
  await request("/api/plan", placement);
  assert.equal((await board()).cards.length, 1);
  await stop();
  await start();
  const restored = await board();
  assert.equal(restored.cards[0].id, placed.cards[0].id);
  assert.equal(restored.library[0].id, meal.id);
  const move = { requestId: randomUUID(), taskId: restored.cards[0].id, kind: "move", slotId: initial.slots[1].id, date: "2026-10-13" };
  await request("/api/change", move);
  assert.equal((await saved(move.requestId)).cards[0].date, move.date);
  const deletion = { requestId: randomUUID(), taskId: restored.cards[0].id, kind: "delete" };
  await request("/api/change", deletion);
  let deleted = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await board()).cards.length) { deleted = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(deleted);
  await stop();
  await start();
  assert.equal((await board()).cards.length, 0);
  console.log("Local production smoke passed: token-free startup, authenticated create/move/delete, replay and restart persistence.");
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
