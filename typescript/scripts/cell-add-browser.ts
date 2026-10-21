// Calendar cell "+": add a meal straight into a day and slot on desktop and phone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-cell-add-"));
const screenshots = process.env.CELL_ADD_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-cell-add");
await mkdir(screenshots, { recursive: true });
const password = `synthetic-${crypto.randomUUID()}`;
const origin = "http://127.0.0.1:3128";
const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  cwd: root,
  stdio: "ignore",
  env: {
    ...process.env,
    TODOIST_MODE: "fake",
    TODOIST_TOKEN: "",
    TODOIST_TOKEN_FILE: "",
    ALLOWED_HOSTS: "127.0.0.1,localhost",
    COOKIE_SECURE: "false",
    DATABASE_PATH: join(directory, "planner.sqlite"),
    APP_PASSWORD: password,
    PORT: "3128",
    HOST: "127.0.0.1",
    PLANNER_ORIGIN: origin,
    PLANNER_DB: join(directory, "planner.sqlite"),
    FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
    FAKE_TODOIST_DELAY_MS: "0",
  },
});
let browser: Browser | undefined;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production server exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("Production server did not become ready");
}
async function login(page: Page) {
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
}
const cell = (page: Page, row: number, column: number) => page.locator(`tbody tr:nth-child(${row}) .meal-cell`).nth(column);
const opacity = (page: Page, row: number, column: number) =>
  cell(page, row, column).locator(".cell-add-button").evaluate((node) => Number(getComputedStyle(node).opacity));
const addDialog = (page: Page) => page.getByRole("dialog", { name: /^Add to / });

try {
  await waitForServer();
  browser = await chromium.launch();

  // Desktop: "+" appears on hover, the dialog focuses its search.
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(desktop);
  await desktop.getByRole("button", { name: "Next week", exact: true }).click();
  const target = cell(desktop, 1, 0);
  assert.equal(await opacity(desktop, 1, 0), 0, "desktop + is hidden until hover");
  await target.hover();
  await sleep(250);
  assert.ok((await opacity(desktop, 1, 0)) > 0.3, "hovering a cell shows its +");
  await target.locator(".cell-add-button").click();
  const dialog = addDialog(desktop);
  await dialog.waitFor();
  assert.match(await dialog.getByRole("heading").innerText(), /^Add to \w{3}, .+ · Breakfast$/);
  assert.equal(await desktop.evaluate(() => document.activeElement?.id), "add-meal-search", "desktop focuses search");
  assert.equal(await dialog.getByText("This time has passed", { exact: false }).count(), 0, "future slots have no past note");
  const meals = await dialog.locator(".add-meal-options button").allInnerTexts();
  assert.ok(meals.length >= 2, "the dialog lists the library");
  const firstMeal = meals[0]!;
  await desktop.locator("#add-meal-search").fill(firstMeal.slice(0, 4).toLowerCase());
  for (const name of await dialog.locator(".add-meal-options button").allInnerTexts())
    assert.ok(name.toLowerCase().includes(firstMeal.slice(0, 4).toLowerCase()), "search filters the list");
  await desktop.screenshot({ path: join(screenshots, "desktop-dialog.png") });
  await dialog.getByRole("button", { name: firstMeal, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await target.locator(".meal-chip[data-card-id]").filter({ hasText: firstMeal }).waitFor();
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  assert.equal(await target.locator(".cell-add-button").evaluate((node) => node === document.activeElement), true, "closing returns focus to the +");

  // A cell that already has a meal still offers +, and a new name is added then planned.
  assert.equal(await target.locator(".cell-add-button").count(), 1, "filled cells keep their +");
  await target.hover();
  await target.locator(".cell-add-button").click();
  await dialog.waitFor();
  const newMeal = `Cell meal ${crypto.randomUUID().slice(0, 6)}`;
  await desktop.locator("#add-meal-search").fill(newMeal);
  assert.equal(await dialog.locator(".add-meal-options").count(), 0, "no library match for a new name");
  await desktop.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await target.locator(".meal-chip[data-card-id]").filter({ hasText: newMeal }).waitFor();
  assert.equal(await target.locator(".meal-chip[data-card-id]").count(), 2, "second meal joins the same slot");
  await desktop.locator(".library-chip").filter({ hasText: newMeal }).waitFor();
  await desktop.screenshot({ path: join(screenshots, "desktop-two-meals.png") });

  // Escape cancels without planning anything.
  const cardsBefore = await desktop.locator(".meal-chip[data-card-id]").count();
  await cell(desktop, 2, 1).hover();
  await cell(desktop, 2, 1).locator(".cell-add-button").click();
  await dialog.waitFor();
  await desktop.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await sleep(300);
  assert.equal(await desktop.locator(".meal-chip[data-card-id]").count(), cardsBefore, "Escape plans nothing");

  // Past slots warn that the meal will be marked as done, and it is.
  await desktop.getByRole("button", { name: "Previous week", exact: true }).click();
  await desktop.getByRole("button", { name: "Previous week", exact: true }).click();
  const past = cell(desktop, 2, 2);
  await past.hover();
  await past.locator(".cell-add-button").click();
  await dialog.getByText("This time has passed, so the meal will be marked as done.").waitFor();
  await dialog.locator(".add-meal-options button").first().click();
  await past.locator(".meal-chip.is-complete").waitFor();

  // Phone: + is faintly visible without hover; the dialog does not pop the keyboard.
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  await login(phone);
  await phone.getByRole("button", { name: "Next week", exact: true }).click();
  const phoneOpacity = await opacity(phone, 3, 1);
  assert.ok(phoneOpacity > 0.2 && phoneOpacity < 0.6, `touch + is faint but visible (${phoneOpacity})`);
  await phone.screenshot({ path: join(screenshots, "phone-grid.png") });

  // A swipe that starts on a + scrolls the board instead of opening the dialog.
  const cdp = await context.newCDPSession(phone);
  const before = await phone.evaluate(() => document.querySelector(".grid-scroll")!.scrollLeft);
  const swipeBox = (await cell(phone, 3, 1).locator(".cell-add-button").boundingBox())!;
  const start = { x: swipeBox.x + swipeBox.width / 2, y: swipeBox.y + swipeBox.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
  for (let step = 1; step <= 5; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x - step * 14, y: start.y, id: 1 }] });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
  assert.ok((await phone.evaluate(() => document.querySelector(".grid-scroll")!.scrollLeft)) > before + 20, "swiping from + scrolls");
  assert.equal(await phone.locator("dialog[open]").count(), 0, "swiping from + opens nothing");

  await phone.evaluate(() => { document.querySelector(".grid-scroll")!.scrollLeft = 0; });
  const phoneTarget = cell(phone, 3, 1);
  const box = (await phoneTarget.locator(".cell-add-button").boundingBox())!;
  await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  const phoneDialog = addDialog(phone);
  await phoneDialog.waitFor();
  assert.equal(await phone.evaluate(() => document.activeElement?.id), "add-meal-title", "phone focuses the heading, not the search");
  await phone.screenshot({ path: join(screenshots, "phone-dialog.png") });
  const option = phoneDialog.locator(".add-meal-options button").first();
  const optionName = await option.innerText();
  const optionBox = (await option.boundingBox())!;
  await phone.touchscreen.tap(optionBox.x + optionBox.width / 2, optionBox.y + optionBox.height / 2);
  await phoneDialog.waitFor({ state: "hidden" });
  await phoneTarget.locator(".meal-chip[data-card-id]").filter({ hasText: optionName }).waitFor();

  console.log(`Cell + checks passed; screenshots in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill();
}
