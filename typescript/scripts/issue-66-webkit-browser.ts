import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webkit, type Browser, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-66-webkit-"));
const screenshots = process.env.ISSUE66_WEBKIT_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-issue-66-webkit");
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
  PORT: "3110",
  HOST: "127.0.0.1",
  PLANNER_ORIGIN: "http://127.0.0.1:3110",
  PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
  FAKE_TODOIST_DELAY_MS: "0",
};
const server = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: root, env, stdio: "ignore" });
let browser: Browser | undefined;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production server exited with ${server.exitCode}`);
    try {
      if ((await fetch("http://127.0.0.1:3110/healthz")).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Production server did not become ready");
}

async function login(page: Page) {
  await page.goto("http://127.0.0.1:3110");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
}

try {
  await waitForServer();
  browser = await webkit.launch();

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desktop.clock.install({ time: "2026-10-07T12:30:00Z" });
  await login(desktop);
  const library = desktop.getByRole("button", { name: /^Plan / }).first();
  const mealName = (await library.getAttribute("aria-label"))!.replace(/^Plan /, "");
  const planDialog = desktop.getByRole("dialog", { name: `Plan ${mealName}` });
  await library.click();
  await planDialog.waitFor();
  assert.equal(await desktop.evaluate(() => document.activeElement?.id), "plan-title", "WebKit Plan dialog starts at its heading");
  const defaultDate = await desktop.locator("#plan-day").inputValue();
  const defaultSlot = await desktop.locator("#plan-slot").inputValue();
  assert.ok(defaultDate, "Plan dialog has a default date");
  assert.ok(defaultSlot, "Plan dialog has a default meal slot");
  await desktop.screenshot({ path: join(screenshots, "desktop-light-plan.png"), fullPage: true });
  await desktop.keyboard.press("Escape");
  await planDialog.waitFor({ state: "hidden" });
  assert.equal(await library.evaluate((node) => node === document.activeElement), true, "Escape returns focus to the Plan trigger");

  await library.click();
  await desktop.getByRole("button", { name: "Plan meal", exact: true }).click();
  let planned = desktop.getByRole("button", { name: `Move or delete ${mealName}`, exact: true });
  await planned.waitFor();
  await desktop.waitForFunction((name) => {
    const card = Array.from(document.querySelectorAll<HTMLElement>(".meal-chip")).find((node) => node.getAttribute("aria-label") === `Move or delete ${name}`);
    return card && !card.classList.contains("is-sync-pending");
  }, mealName);
  const plannedCell = planned.locator("xpath=ancestor::td[contains(@class,'meal-cell')]");
  const plannedDate = await plannedCell.getAttribute("data-date");
  const plannedSlot = await plannedCell.getAttribute("data-slot-id");
  await planned.click();
  const moveDialog = desktop.getByRole("dialog", { name: `Move ${mealName}` });
  await moveDialog.waitFor();
  assert.equal(await desktop.locator("#plan-day").inputValue(), plannedDate, "Move defaults to the planned date");
  assert.equal(await desktop.locator("#plan-slot").inputValue(), plannedSlot, "Move defaults to the planned slot");
  await desktop.emulateMedia({ colorScheme: "dark" });
  await desktop.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await desktop.screenshot({ path: join(screenshots, "desktop-dark-move.png"), fullPage: true });
  await desktop.keyboard.press("Escape");
  await moveDialog.waitFor({ state: "hidden" });
  assert.equal(await planned.evaluate((node) => node === document.activeElement), true, "Escape returns focus to the planned card");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.clock.install({ time: "2026-10-07T12:30:00Z" });
  await mobile.addInitScript(() => {
    const trusted: boolean[] = [];
    Object.assign(window, { issue66WebKitTrustedTouches: trusted });
    document.addEventListener("touchstart", (event) => trusted.push(event.isTrusted), true);
  });
  await login(mobile);
  await mobile.emulateMedia({ colorScheme: "light" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "light");

  const mobilePlanned = mobile.getByRole("button", { name: `Move or delete ${mealName}`, exact: true });
  await mobilePlanned.scrollIntoViewIfNeeded();
  const plannedBox = await mobilePlanned.boundingBox();
  assert.ok(plannedBox);
  await mobile.touchscreen.tap(plannedBox.x + plannedBox.width / 2, plannedBox.y + plannedBox.height / 2);
  const mobileMove = mobile.getByRole("dialog", { name: `Move ${mealName}` });
  await mobileMove.waitFor();
  assert.equal(await mobile.locator("#plan-day").inputValue(), plannedDate, "WebKit touch opens Move with the planned date");
  assert.equal(await mobile.locator("#plan-slot").inputValue(), plannedSlot, "WebKit touch opens Move with the planned slot");
  const trustedTaps = await mobile.evaluate(() => (window as unknown as { issue66WebKitTrustedTouches: boolean[] }).issue66WebKitTrustedTouches);
  assert.ok(trustedTaps.length > 0 && trustedTaps.every(Boolean), "WebKit touch uses trusted browser touch events");
  const cancelBox = await mobile.getByRole("button", { name: "Cancel", exact: true }).boundingBox();
  assert.ok(cancelBox);
  await mobile.touchscreen.tap(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await mobileMove.waitFor({ state: "hidden" });
  assert.equal(await mobilePlanned.evaluate((node) => node === document.activeElement), true, "touch-canceling Move restores focus to its card");

  const planTrigger = mobile.getByRole("button", { name: `Plan ${mealName}`, exact: true });
  const planTriggerBox = await planTrigger.boundingBox();
  assert.ok(planTriggerBox);
  await mobile.touchscreen.tap(planTriggerBox.x + planTriggerBox.width / 2, planTriggerBox.y + planTriggerBox.height / 2);
  const mobilePlan = mobile.getByRole("dialog", { name: `Plan ${mealName}` });
  await mobilePlan.waitFor();
  assert.equal(await mobile.evaluate(() => document.activeElement?.id), "plan-title", "WebKit touch Plan dialog starts at its heading");
  assert.ok(await mobile.locator("#plan-day").inputValue(), "touch Plan keeps its default date");
  assert.ok(await mobile.locator("#plan-slot").inputValue(), "touch Plan keeps its default slot");
  await mobile.screenshot({ path: join(screenshots, "mobile-light-plan.png"), fullPage: true });
  await mobile.keyboard.press("Escape");
  await mobilePlan.waitFor({ state: "hidden" });

  await planned.click();
  const webkitDateOptions = await desktop.locator("#plan-day option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const nextDate = webkitDateOptions.find((value) => value && value !== plannedDate);
  const webkitSlotOptions = await desktop.locator("#plan-slot option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const nextSlot = webkitSlotOptions.find((value) => value && value !== plannedSlot);
  assert.ok(nextDate && nextSlot, "WebKit desktop Move dialog offers alternate defaults");
  await desktop.locator("#plan-day").selectOption(nextDate);
  await desktop.locator("#plan-slot").selectOption(nextSlot);
  const changeResponse = desktop.waitForResponse((response) => response.url().endsWith("/api/change") && response.request().method() === "POST");
  await desktop.getByRole("button", { name: "Move meal", exact: true }).click();
  const response = await changeResponse;
  const change = response.request().postDataJSON() as { kind?: string; requestId: string; taskId?: string; date: string; slotId: string };
  assert.equal(change.kind, "move", "WebKit desktop Move submits a move mutation");
  assert.equal(change.taskId, await planned.getAttribute("data-card-id"));
  assert.equal(change.date, nextDate);
  assert.equal(change.slotId, nextSlot);
  await desktop.waitForFunction(({ name, date, slot }) => {
    const card = Array.from(document.querySelectorAll<HTMLElement>(".meal-chip")).find((node) => node.getAttribute("aria-label") === `Move or delete ${name}`);
    const cell = card?.closest<HTMLElement>(".meal-cell");
    return cell?.dataset.date === date && cell.dataset.slotId === slot && !card?.classList.contains("is-sync-pending");
  }, { name: mealName, date: nextDate, slot: nextSlot });

  await desktop.getByRole("button", { name: `Move or delete ${mealName}`, exact: true }).click();
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  const confirmation = desktop.getByRole("dialog", { name: "Confirm meal deletion" });
  await confirmation.waitFor();
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  assert.equal(await planned.count(), 1, "canceling delete leaves the planned meal intact");
  await planned.click();
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  await confirmation.waitFor();
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  await planned.waitFor({ state: "detached" });
  assert.equal(await desktop.locator("dialog[open]").count(), 0, "confirmed desktop delete closes its dialogs");

  console.log(`Issue 66 production WebKit app smoke passed; screenshots saved in ${screenshots}. Touch drag gestures were not exercised.`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve())).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
