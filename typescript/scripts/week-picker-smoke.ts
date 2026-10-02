import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const root = process.cwd();
const out = join(root, ".local/comparison");
await mkdir(join(out, "browser-data"), { recursive: true });
const password = randomUUID();
const port = 3196;
const origin = `http://127.0.0.1:${port}`;
const database = join(out, "browser-data", `planner-${password}.sqlite`);
const env = {
  ...process.env,
  TODOIST_MODE: "fake",
  TODOIST_TOKEN: "",
  TODOIST_TOKEN_FILE: "",
  ALLOWED_HOSTS: "127.0.0.1,localhost",
  COOKIE_SECURE: "false",
  DATABASE_PATH: database,
  APP_PASSWORD: password,
  PORT: String(port),
  HOST: "127.0.0.1",
  PLANNER_ORIGIN: origin,
  PLANNER_DB: database,
  FAKE_TODOIST_DB: join(out, "browser-data", `provider-${password}.sqlite`),
  FAKE_TODOIST_DELAY_MS: "0",
  FAKE_TODOIST_FAIL_BEFORE: "0",
  FAKE_TODOIST_LOSE_RESPONSE: "0",
  FAKE_TODOIST_MOVE_FAIL_BEFORE: "0",
  FAKE_TODOIST_DELETE_FAIL_BEFORE: "0",
};
const server = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; }
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, `Synthetic application server did not start:\n${serverLog}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", reducedMotion: "reduce", hasTouch: true });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Weekly plan", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);

  const weekButton = page.getByRole("button", { name: /^Choose week,/ });
  await weekButton.click();
  const dialog = page.getByRole("dialog", { name: "Choose a week" });
  await dialog.waitFor({ state: "visible" });
  const currentWeek = dialog.locator('.week-calendar-week[aria-pressed="true"]');
  assert.equal(await currentWeek.count(), 1, "the displayed planner week is highlighted");
  assert.equal(await currentWeek.locator(".week-calendar-date").count(), 7, "the full Monday-to-Sunday week is highlighted");
  assert.equal(await dialog.locator(".week-calendar-month:not(:empty)").count(), 5, "picker shows exactly five month labels");
  const currentMonthCell = dialog.locator(`.week-calendar-date.is-current-month`).first();
  assert.ok(await currentMonthCell.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity) > .9));
  assert.equal(await dialog.locator(".week-calendar-date.is-adjacent-month").first().evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)), .68);
  await page.screenshot({ path: join(out, "week-picker-desktop-light.png"), fullPage: true });

  const openedButton = page.locator(".week-title");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await openedButton.evaluate((button) => button === document.activeElement), true, "Escape returns focus to the week label");

  // Week arrows remain unbounded even though the picker is bounded.
  for (let index = 0; index < 22; index++) await page.getByRole("button", { name: "Next week", exact: true }).click();
  await weekButton.click();
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.locator('.week-calendar-week[aria-pressed="true"]').count(), 0, "out-of-window planner week is preserved without a false highlight");
  await page.screenshot({ path: join(out, "week-picker-outside-window.png"), fullPage: true });
  const fallbackFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-week-start"));
  assert.ok(fallbackFocus, "opening outside the window focuses a week in the allowed calendar");
  await page.keyboard.press("Tab");
  const keyboardChoice = dialog.locator(".week-calendar-week:focus");
  const keyboardWeek = await keyboardChoice.getAttribute("data-week-start");
  assert.ok(keyboardWeek && keyboardWeek !== fallbackFocus);
  const boardRequest = page.waitForRequest((request) => request.url().includes(`/api/board?week=${keyboardWeek}`));
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await boardRequest;
  const chosenDate = new Date(`${keyboardWeek}T12:00:00Z`);
  const endDate = new Date(chosenDate);
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  const expectedTitle = `${chosenDate.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })} – ${endDate.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })}`;
  const [startLabel, endLabel] = expectedTitle.split(" – ");
  await page.getByRole("button", { name: `Choose week, ${startLabel} through ${endLabel}` }).waitFor();
  assert.equal(await page.locator(".week-title").evaluate((button) => button === document.activeElement), true, "keyboard selection returns focus to the opener");

  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.locator("html[data-theme=dark]").waitFor();
  await weekButton.click();
  await dialog.waitFor({ state: "visible" });
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, "desktop modal fits the viewport");
  await page.screenshot({ path: join(out, "week-picker-desktop-dark.png"), fullPage: true });

  await page.setViewportSize({ width: 360, height: 740 });
  await page.screenshot({ path: join(out, "week-picker-mobile-dark.png"), fullPage: true });
  const mobileBounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  assert.ok(mobileBounds.left >= 0 && mobileBounds.right <= mobileBounds.width && mobileBounds.top >= 0 && mobileBounds.bottom <= mobileBounds.height, "mobile modal fits the viewport");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page has no horizontal overflow");
  await page.getByRole("button", { name: "Close week picker", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  const beforeMobilePick = await page.locator(".week-title").innerText();
  await weekButton.tap();
  await dialog.waitFor({ state: "visible" });
  const mobileChoice = dialog.locator(".week-calendar-week").nth(1);
  const mobileWeek = await mobileChoice.getAttribute("data-week-start");
  const mobileBoardRequest = page.waitForRequest((request) => request.url().includes(`/api/board?week=${mobileWeek}`));
  await mobileChoice.tap();
  await dialog.waitFor({ state: "hidden" });
  await mobileBoardRequest;
  assert.notEqual(await page.locator(".week-title").innerText(), beforeMobilePick, "a tap selects a new week and closes the picker");

  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.locator("html[data-theme=light]").waitFor();
  await weekButton.tap();
  await dialog.waitFor({ state: "visible" });
  await page.screenshot({ path: join(out, "week-picker-mobile-light.png"), fullPage: true });
  await page.keyboard.press("Escape");
  assert.deepEqual(pageErrors, [], `browser console errors: ${pageErrors.join(", ")}`);
  console.log(JSON.stringify({ result: "passed", assertions: ["selected cross-month week", "five-month picker bounds", "unbounded arrows", "out-of-window preservation", "keyboard selection", "Escape and focus return", "mobile tap opens and selects a week", "mobile and desktop viewport fit", "dark and light themes", "reduced motion"], screenshots: ["week-picker-desktop-light.png", "week-picker-outside-window.png", "week-picker-desktop-dark.png", "week-picker-mobile-dark.png", "week-picker-mobile-light.png"], pageErrors }, null, 2));
} catch (error) {
  console.error(error);
  console.error(serverLog);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
}
