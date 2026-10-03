import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-42-"));
const screenshots = process.env.ISSUE42_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-issue-42");
await mkdir(screenshots, { recursive: true });
const password = `synthetic-${crypto.randomUUID()}`;
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  TODOIST_MODE: "fake",
  PRISMA_DISABLE_TELEMETRY: "1",
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

async function login(page: Page) {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
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

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(desktop);

  const libraryMeal = desktop.locator(".library-chip").first();
  const plannedName = (await libraryMeal.innerText()).replace("⠿", "").trim();
  await libraryMeal.click();
  await desktop.getByRole("button", { name: "Plan meal", exact: true }).click();
  let planned = desktop.locator(".meal-chip").filter({ hasText: plannedName });
  await planned.waitFor();
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  assert.equal(await planned.getAttribute("role"), "button");
  assert.equal(await planned.locator("button").count(), 0, "saved card has no move/delete icon buttons");
  await desktop.screenshot({ path: join(screenshots, "desktop-light.png"), fullPage: true });

  const changes: { kind?: string; requestId: string; date?: string; slotId?: string }[] = [];
  await desktop.route("**/api/change", async (route) => {
    changes.push(route.request().postDataJSON() as (typeof changes)[number]);
    await route.continue();
  });
  await planned.click();
  let actionDialog = desktop.getByRole("dialog", { name: `Move ${plannedName}` });
  await actionDialog.waitFor();
  await desktop.screenshot({ path: join(screenshots, "desktop-light-actions.png"), fullPage: true });
  for (let index = 0; index < 6; index++) await desktop.keyboard.press("Tab");
  assert.equal(await actionDialog.evaluate((node) => node.contains(document.activeElement)), true, "Tab remains in the modal dialog");
  await desktop.keyboard.press("Escape");
  await actionDialog.waitFor({ state: "hidden" });
  await assertFocusOnCard(desktop, planned);

  await planned.focus();
  await desktop.keyboard.press("Enter");
  actionDialog = desktop.getByRole("dialog", { name: `Move ${plannedName}` });
  await actionDialog.waitFor();
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  const confirmation = desktop.getByRole("dialog", { name: "Confirm meal deletion" });
  await confirmation.waitFor();
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  await assertFocusOnCard(desktop, planned);

  await planned.click();
  await desktop.locator("#plan-day").selectOption({ index: 1 });
  await desktop.locator("#plan-slot").selectOption({ index: 1 });
  const moveDate = await desktop.locator("#plan-day").inputValue();
  const moveSlot = await desktop.locator("#plan-slot").inputValue();
  await desktop.getByRole("button", { name: "Move meal", exact: true }).click();
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  assert.equal(changes.at(-1)?.kind, "move");
  assert.equal(changes.at(-1)?.date, moveDate);
  assert.equal(changes.at(-1)?.slotId, moveSlot);
  assert.match(changes.at(-1)?.requestId ?? "", /^[0-9a-f-]{36}$/i);
  planned = desktop.locator(".meal-chip").filter({ hasText: plannedName });

  await planned.click();
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  await desktop.getByRole("dialog", { name: "Confirm meal deletion" }).waitFor();
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await planned.count(), 1, "canceling explicit delete keeps the card");

  const failureIds: string[] = [];
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  await desktop.route("**/api/change", async (route) => {
    failureIds.push((route.request().postDataJSON() as { requestId: string }).requestId);
    await failureGate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic provider failure" }) });
  });
  await planned.click();
  await desktop.locator("#plan-day").selectOption({ index: 2 });
  await desktop.getByRole("button", { name: "Move meal", exact: true }).click();
  await desktop.getByRole("button", { name: "Saving meal", exact: true }).waitFor();
  releaseFailure();
  const retry = desktop.getByRole("button", { name: /^Retry meal:/ });
  await retry.waitFor();
  const pending = JSON.parse((await desktop.evaluate(() => sessionStorage.getItem("planner-pending-http"))) ?? "[]") as { card: { requestId: string } }[];
  assert.equal(failureIds.length, 1);
  assert.equal(pending.at(-1)?.card.requestId, failureIds[0], "failed action retains its request ID");
  await desktop.unroute("**/api/change");
  await retry.click();
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  assert.equal(failureIds.length, 1, "retry continues the saved intent without creating another request ID");
  await desktop.route("**/api/change", async (route) => {
    changes.push(route.request().postDataJSON() as (typeof changes)[number]);
    await route.continue();
  });
  await desktop.emulateMedia({ colorScheme: "dark" });
  await desktop.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await desktop.screenshot({ path: join(screenshots, "desktop-dark.png"), fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await login(mobile);
  await mobile.emulateMedia({ colorScheme: "light" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const mobilePlanned = mobile.locator(".meal-chip").filter({ hasText: plannedName });
  await mobilePlanned.waitFor();
  assert.equal(await mobilePlanned.getAttribute("draggable"), "false", "touch card stays scrollable");
  await mobile.screenshot({ path: join(screenshots, "mobile-light.png"), fullPage: true });
  const bounds = await mobilePlanned.boundingBox();
  assert.ok(bounds);
  const cdp = await mobile.context().newCDPSession(mobile);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const mobileDialog = mobile.getByRole("dialog", { name: `Move ${plannedName}` });
  await mobileDialog.waitFor();
  await mobile.screenshot({ path: join(screenshots, "mobile-light-actions.png"), fullPage: true });
  await mobile.getByRole("button", { name: "Cancel", exact: true }).click();
  await mobileDialog.waitFor({ state: "hidden" });

  const scrollBox = await mobilePlanned.boundingBox();
  assert.ok(scrollBox);
  const beforeScroll = await mobile.evaluate(() => window.scrollY);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: scrollBox.x + scrollBox.width / 2, y: scrollBox.y + scrollBox.height / 2, id: 1 }] });
  for (let step = 1; step <= 5; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: scrollBox.x + scrollBox.width / 2, y: scrollBox.y + scrollBox.height / 2 - step * 22, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobile.waitForTimeout(100);
  assert.equal(await mobile.locator("dialog[open]").count(), 0, "scrolling a touch card does not open the dialog");
  assert.ok((await mobile.evaluate(() => window.scrollY)) > beforeScroll, "touch scroll remains available on a planned card");
  await mobile.emulateMedia({ colorScheme: "dark" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await mobile.screenshot({ path: join(screenshots, "mobile-dark.png"), fullPage: true });

  await mobile.close();
  await planned.click();
  await desktop.keyboard.press("Escape");
  await desktop.waitForTimeout(450);
  await planned.evaluate((node) => node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() })));
  assert.ok((await desktop.locator("body").getAttribute("class"))?.includes("planner-dragging"));
  await desktop.keyboard.press("Escape");
  assert.equal((await desktop.locator("body").getAttribute("class"))?.includes("planner-dragging"), false);
  await planned.dragTo(desktop.locator(".meal-cell").last(), { force: true });
  assert.equal(await desktop.locator("dialog[open]").count(), 0, "drag completion never opens the card dialog");
  assert.equal((await desktop.locator("body").getAttribute("class"))?.includes("planner-dragging"), false);
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  planned = desktop.locator(".meal-chip").filter({ hasText: plannedName });
  await planned.dragTo(desktop.getByLabel("Delete dragged planned meal", { exact: true }), { force: true });
  await desktop.getByRole("dialog", { name: "Confirm meal deletion" }).waitFor();
  assert.equal((await desktop.locator("body").getAttribute("class"))?.includes("planner-dragging"), false);
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await planned.count(), 1);
  await planned.dragTo(desktop.getByLabel("Delete dragged planned meal", { exact: true }), { force: true });
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  await planned.waitFor({ state: "detached" });
  assert.equal(changes.at(-1)?.kind, "delete");
  assert.equal(await desktop.locator("dialog[open]").count(), 0);

  console.log(`Issue 42 production browser checks passed; screenshots saved in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}

async function assertFocusOnCard(page: Page, card: ReturnType<Page["locator"]>) {
  assert.equal(await card.evaluate((node) => node === document.activeElement), true, "closing the dialog returns focus to its card");
}
