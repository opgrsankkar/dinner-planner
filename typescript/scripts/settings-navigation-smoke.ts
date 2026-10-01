import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const directory = await mkdtemp(join(tmpdir(), "planner-browser-"));
const password = randomUUID();
const env = {
  ...process.env,
  TODOIST_MODE: "fake",
  TODOIST_TOKEN: "",
  TODOIST_TOKEN_FILE: "",
  ALLOWED_HOSTS: "127.0.0.1,localhost",
  COOKIE_SECURE: "false",
  DATABASE_PATH: join(directory, "planner.sqlite"),
  APP_PASSWORD: password,
  PORT: "3101",
  HOST: "127.0.0.1",
  PLANNER_ORIGIN: "http://127.0.0.1:3101",
  PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
  FAKE_TODOIST_DELAY_MS: "1800",
  FAKE_TODOIST_FAIL_BEFORE: "2",
  FAKE_TODOIST_LOSE_RESPONSE: "0",
  FAKE_TODOIST_MOVE_FAIL_BEFORE: "2",
  FAKE_TODOIST_DELETE_FAIL_BEFORE: "2",
};
const server = spawn(process.execPath, ["scripts/serve.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(env.PLANNER_ORIGIN + "/healthz")).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, output);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(env.PLANNER_ORIGIN + "/settings");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (!page.url().endsWith("/settings")) await page.getByRole("link", { name: "Settings", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  const open = async (name: string) => { await nav.getByRole("button", { name, exact: true }).click(); };
  const onePanel = async () => assert.equal(await page.locator('.settings-panels > div[id]:visible').count(), 1);
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await onePanel();
  assert.equal(await nav.getByRole("button", { name: "Appearance", exact: true }).getAttribute("aria-current"), "page");
  // Keep the same DOM nodes as well as their values across section navigation.
  await open("Meal slots");
  await page.getByLabel("Slot label 1", { exact: true }).fill("Navigation draft");
  await page.getByLabel("Slot label 1", { exact: true }).evaluate((input) => { input.setAttribute("data-mount-marker", "original"); });
  await open("Meal library");
  await page.getByLabel("Find a meal", { exact: true }).fill("pasta");
  await open("Appearance");
  await open("Meal library");
  assert.equal(await page.getByLabel("Find a meal", { exact: true }).inputValue(), "pasta");
  await open("Meal slots");
  assert.equal(await page.getByLabel("Slot label 1", { exact: true }).inputValue(), "Navigation draft");
  assert.equal(await page.getByLabel("Slot label 1", { exact: true }).getAttribute("data-mount-marker"), "original");
  await onePanel();
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), true);
  await page.screenshot({ path: join(tmpdir(), "settings-navigation-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "← Back to settings", exact: true }).click();
  assert.equal(await page.locator('.settings-panels > div[id]:visible').count(), 0);
  assert.equal(await nav.getByRole("button").count(), 3);
  assert.equal(await page.getByRole("link", { name: "← Back to plan", exact: true }).isVisible(), true);
  await page.screenshot({ path: join(tmpdir(), "settings-navigation-mobile-landing.png"), fullPage: true });
  for (const name of ["Appearance", "Meal library", "Meal slots"]) {
    await open(name);
    await onePanel();
    assert.equal(await nav.isVisible(), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (name === "Meal library") assert.equal(await page.getByLabel("Find a meal", { exact: true }).inputValue(), "pasta");
    if (name === "Meal slots") {
      assert.equal(await page.getByLabel("Slot label 1", { exact: true }).inputValue(), "Navigation draft");
      await page.screenshot({ path: join(tmpdir(), "settings-navigation-mobile-slots.png"), fullPage: true });
      await page.getByRole("button", { name: "Revert", exact: true }).click();
      assert.equal(await page.getByLabel("Slot label 1", { exact: true }).inputValue(), "Breakfast");
    }
    await page.getByRole("button", { name: "← Back to settings", exact: true }).click();
    assert.equal(await nav.getByRole("button", { name, exact: true }).evaluate((button) => button === document.activeElement), true);
  }
  await page.reload();
  await nav.waitFor();
  assert.equal(await page.locator('.settings-panels > div[id]:visible').count(), 0);
  await page.getByRole("link", { name: "← Back to plan", exact: true }).click();
  await page.getByRole("navigation", { name: "Week navigation" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Settings navigation smoke passed: desktop/mobile panels, active indication, preserved mounts/search/drafts, Revert, focus return, mobile landing/reload, Back to plan. Screenshots saved to TMPDIR.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  await rm(directory, { recursive: true, force: true });
}
