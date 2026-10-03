import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import type { Board, Card } from "../src/types";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-36-"));
const screenshots = process.env.ISSUE36_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-issue-36");
await mkdir(screenshots, { recursive: true });
const password = `synthetic-${crypto.randomUUID()}`;
const env = {
  ...process.env,
  TODOIST_MODE: "fake",
  TODOIST_TOKEN: "",
  TODOIST_TOKEN_FILE: "",
  ALLOWED_HOSTS: "127.0.0.1,localhost",
  COOKIE_SECURE: "false",
  DATABASE_PATH: join(directory, "planner.sqlite"),
  APP_PASSWORD: password,
  PORT: "3100",
  HOST: "127.0.0.1",
  PLANNER_ORIGIN: "http://127.0.0.1:3100",
  PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
  FAKE_TODOIST_DELAY_MS: "0",
};
const server = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: root, env, stdio: "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let fixtureCards: Card[] = [];
let reverseSlots = false;

function syntheticCard(date: string, time: string, deleting = false): Card {
  const id = `synthetic-${date}-${time}-${deleting ? "delete" : "create"}`;
  return {
    id,
    projectId: "synthetic-project",
    name: "Synthetic occupancy",
    date,
    time,
    requestId: id,
    state: "pending",
    error: "",
    confirmedAt: 0,
    ...(deleting ? { deleting: true } : {}),
  };
}

async function installBoardFixtures(page: Page) {
  await page.route("**/api/board?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Board;
    if (!response.ok || !Array.isArray(body.cards) || !Array.isArray(body.slots)) {
      await route.fulfill({ response });
      return;
    }
    body.cards = [...body.cards, ...fixtureCards];
    if (reverseSlots) body.slots.reverse();
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production server exited with ${server.exitCode}`);
    try {
      if ((await fetch("http://127.0.0.1:3100/healthz")).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Production server did not become ready");
}

async function setClock(page: Page, time: string) {
  await page.clock.setFixedTime(time);
  await page.waitForTimeout(650);
}

async function login(page: Page) {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
}

async function showThisWeek(page: Page) {
  const button = page.getByRole("button", { name: "This week", exact: true });
  if (await button.count()) await button.click();
  await page.waitForTimeout(650);
}

async function openPlan(page: Page, name: string) {
  await page.getByRole("button", { name: `Plan ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Plan ${name}` });
  await dialog.waitFor();
  return dialog;
}

async function assertPlan(page: Page, date: string, slotId: string) {
  assert.equal(await page.locator("#plan-day").inputValue(), date);
  assert.equal(await page.locator("#plan-slot").inputValue(), slotId);
}

async function assertFocusOn(page: Page, target: ReturnType<Page["locator"]>, message: string) {
  assert.equal(await target.evaluate((node) => node === document.activeElement), true, message);
}

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "UTC" });
  await desktop.clock.install({ time: "2026-10-07T12:30:00Z" });
  await installBoardFixtures(desktop);
  await login(desktop);
  await showThisWeek(desktop);
  const board = await desktop.evaluate(async () => await (await fetch("/api/board?week=2026-10-05")).json() as Board);
  const slotId = (time: string) => board.slots.find((slot) => slot.time === time)!.id;
  const mealButton = desktop.getByRole("button", { name: /^Plan / }).first();
  const mealName = (await mealButton.getAttribute("aria-label"))!.replace("Plan ", "");

  // At 18:59 Kolkata, past slots are skipped and dinner remains eligible.
  await setClock(desktop, "2026-10-07T13:29:00Z");
  let dialog = await openPlan(desktop, mealName);
  await assertPlan(desktop, "2026-10-07", slotId("19:00"));
  await desktop.screenshot({ path: join(screenshots, "after-desktop-light-plan-dialog.png"), fullPage: true });
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await assertFocusOn(desktop, mealButton, "Plan cancel returns focus to its library control");

  // The exact cutoff is still eligible. New time and board data are read on reopening.
  await setClock(desktop, "2026-10-07T13:30:00Z");
  fixtureCards = [syntheticCard("2026-10-07", "19:00"), syntheticCard("2026-10-08", "08:00", true)];
  await desktop.waitForTimeout(650);
  dialog = await openPlan(desktop, mealName);
  await assertPlan(desktop, "2026-10-08", slotId("13:00"));
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();

  // Pending create destinations and pending deletes both continue to occupy their cells.
  await setClock(desktop, "2026-10-07T12:30:00Z");
  fixtureCards = [syntheticCard("2026-10-07", "19:00"), syntheticCard("2026-10-08", "08:00", true)];
  await desktop.waitForTimeout(650);
  dialog = await openPlan(desktop, mealName);
  await assertPlan(desktop, "2026-10-08", slotId("13:00"));
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();

  // A full or historical viewed week never silently selects an occupied or past cell.
  fixtureCards = Array.from({ length: 21 }, (_, index) => {
    const date = new Date("2026-10-05T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + Math.floor(index / 3));
    return syntheticCard(date.toISOString().slice(0, 10), ["08:00", "13:00", "19:00"][index % 3]);
  });
  await desktop.waitForTimeout(650);
  dialog = await openPlan(desktop, mealName);
  assert.equal(await desktop.locator("#plan-day").inputValue(), "");
  assert.equal(await desktop.locator("#plan-slot").inputValue(), "");
  assert.match(await dialog.innerText(), /No eligible empty slot is available in this displayed week/);
  assert.equal(await desktop.getByRole("button", { name: "Plan meal", exact: true }).isDisabled(), true);
  await desktop.locator("#plan-day").selectOption("2026-10-07");
  await desktop.locator("#plan-slot").selectOption(slotId("19:00"));
  assert.equal(await desktop.getByRole("button", { name: "Plan meal", exact: true }).isEnabled(), true, "manual planning remains available");
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();

  fixtureCards = [];
  await desktop.getByRole("button", { name: "Next week", exact: true }).click();
  await desktop.waitForTimeout(650);
  dialog = await openPlan(desktop, mealName);
  assert.equal(await desktop.locator("#plan-day").inputValue(), "");
  assert.equal(await desktop.locator("#plan-slot").inputValue(), "");
  assert.match(await dialog.innerText(), /Default suggestions are limited to the current week/);
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await desktop.getByRole("button", { name: "Previous week", exact: true }).click();
  await desktop.getByRole("button", { name: "Previous week", exact: true }).click();
  await desktop.waitForTimeout(650);
  dialog = await openPlan(desktop, mealName);
  assert.equal(await desktop.locator("#plan-day").inputValue(), "");
  assert.equal(await desktop.locator("#plan-slot").inputValue(), "");
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();

  // Browser UTC is still Oct 4 while Kolkata has crossed midnight into Monday Oct 5.
  await setClock(desktop, "2026-10-04T18:35:00Z");
  await showThisWeek(desktop);
  assert.equal(await desktop.evaluate(() => new Date().getUTCDate()), 4);
  dialog = await openPlan(desktop, mealName);
  await assertPlan(desktop, "2026-10-05", slotId("08:00"));
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();

  // A reversed slot array does not affect chronological selection.
  reverseSlots = true;
  await setClock(desktop, "2026-10-07T12:30:00Z");
  dialog = await openPlan(desktop, mealName);
  await assertPlan(desktop, "2026-10-07", slotId("19:00"));
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  reverseSlots = false;

  // Plan a real meal through synthetic SQLite/fake Todoist, then preserve Move defaults and controls.
  const planRequests: { date: string; slotId: string }[] = [];
  const moveRequests: { kind?: string; date?: string; slotId?: string }[] = [];
  await desktop.route("**/api/plan", async (route) => {
    planRequests.push(route.request().postDataJSON() as (typeof planRequests)[number]);
    await route.continue();
  });
  await desktop.route("**/api/change", async (route) => {
    moveRequests.push(route.request().postDataJSON() as (typeof moveRequests)[number]);
    await route.continue();
  });
  fixtureCards = [];
  await setClock(desktop, "2026-10-07T12:00:00Z");
  dialog = await openPlan(desktop, mealName);
  await assertPlan(desktop, "2026-10-07", slotId("19:00"));
  await desktop.getByRole("button", { name: "Plan meal", exact: true }).click();
  await desktop.locator('.meal-chip[role="button"]').filter({ hasText: mealName }).waitFor();
  assert.equal(planRequests.at(-1)?.date, "2026-10-07");
  assert.equal(planRequests.at(-1)?.slotId, slotId("19:00"));

  let planned = desktop.locator(".meal-chip").filter({ hasText: mealName });
  await planned.click();
  dialog = desktop.getByRole("dialog", { name: `Move ${mealName}` });
  await dialog.waitFor();
  await assertPlan(desktop, "2026-10-07", slotId("19:00"));
  assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, "opening Move focuses a modal control");
  await desktop.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await assertFocusOn(desktop, planned, "Move cancel returns focus to its card");

  await planned.click();
  dialog = desktop.getByRole("dialog", { name: `Move ${mealName}` });
  await dialog.waitFor();
  await desktop.locator("#plan-day").selectOption("2026-10-08");
  await desktop.locator("#plan-slot").selectOption(slotId("08:00"));
  await desktop.getByRole("button", { name: "Move meal", exact: true }).click();
  await desktop.waitForTimeout(650);
  assert.deepEqual(
    { kind: moveRequests.at(-1)?.kind, date: moveRequests.at(-1)?.date, slotId: moveRequests.at(-1)?.slotId },
    { kind: "move", date: "2026-10-08", slotId: slotId("08:00") },
  );

  await openPlan(desktop, mealName);
  assert.equal(await desktop.getByRole("button", { name: "Delete meal", exact: true }).count(), 0, "Plan after Move remains non-destructive");
  await assertPlan(desktop, "2026-10-07", slotId("19:00"));
  await desktop.emulateMedia({ colorScheme: "dark" });
  await desktop.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await desktop.screenshot({ path: join(screenshots, "after-desktop-dark-plan-dialog.png"), fullPage: true });
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await assertFocusOn(desktop, mealButton, "Plan after Move returns focus to its library control");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "UTC" });
  await mobile.clock.install({ time: "2026-10-07T12:30:00Z" });
  await installBoardFixtures(mobile);
  await login(mobile);
  await showThisWeek(mobile);
  await mobile.emulateMedia({ colorScheme: "light" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "light");
  dialog = await openPlan(mobile, mealName);
  await assertPlan(mobile, "2026-10-07", slotId("19:00"));
  await mobile.screenshot({ path: join(screenshots, "after-mobile-light-plan-dialog.png"), fullPage: true });
  await mobile.getByRole("button", { name: "Cancel", exact: true }).click();
  await mobile.emulateMedia({ colorScheme: "dark" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  dialog = await openPlan(mobile, mealName);
  await mobile.screenshot({ path: join(screenshots, "after-mobile-dark-plan-dialog.png"), fullPage: true });
  await mobile.getByRole("button", { name: "Cancel", exact: true }).click();

  console.log(`Issue 36 production browser checks passed; screenshots saved in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve())).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
