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
  ...process.env, TODOIST_MODE: "local",
  DATABASE_PATH: join(directory, "planner.sqlite"), PLANNER_ORIGIN: origin,
  HOST: "127.0.0.1", PORT: "3197",   ALLOWED_HOSTS: "127.0.0.1", TODOIST_TOKEN: "",
  // Proves local mode does not read a token even when a file is configured.
  TODOIST_TOKEN_FILE: join(directory, "nonexistent-token"),
};
let server: ReturnType<typeof spawn> | undefined;
let output = "";
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
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
// Next week's Monday and Tuesday: every slot there is in the future, so new
// placements are never auto-completed as past meals.
const day = (offset: number) => {
  const date = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset - ((date.getUTCDay() + 6) % 7) + 7);
  return date.toISOString().slice(0, 10);
};
const week = day(0);
async function board(): Promise<Board> { return (await request(`/api/board?week=${week}`)).json(); }
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
  const initial = await board();
  assert.equal(initial.integrationError, "");
  assert.equal(initial.library.length, 0);
  const meal = await (await request("/api/library", { name: "Standalone dinner" })).json();
  const placement = { requestId: randomUUID(), mealId: meal.id, slotId: initial.slots[0].id, date: week };
  await request("/api/plan", placement);
  const placed = await saved(placement.requestId);
  await request("/api/plan", placement);
  assert.equal((await board()).cards.length, 1);
  await stop();
  await start();
  const restored = await board();
  assert.equal(restored.cards[0].id, placed.cards[0].id);
  assert.equal(restored.library[0].id, meal.id);
  const move = { requestId: randomUUID(), taskId: restored.cards[0].id, kind: "move", slotId: initial.slots[1].id, date: day(1) };
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
  console.log("Local production smoke passed: token-free startup, create/move/delete, replay and restart persistence.");
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
