import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-68-"));
const screenshots = process.env.ISSUE68_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-issue-68");
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
let browser: Browser | undefined;

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

async function login(page: Page) {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
}

async function inspect(browser: Browser, name: string, mobile: boolean) {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: "UTC",
  });
  await page.clock.install({ time: "2026-10-07T12:30:00Z" });
  await login(page);
  const trigger = page.getByRole("button", { name: /^Plan / }).first();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /^Plan / });
    await dialog.waitFor();
    const focus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      id: (document.activeElement as HTMLElement | null)?.id,
      dateFocused: document.activeElement === document.querySelector("#plan-day"),
      slotFocused: document.activeElement === document.querySelector("#plan-slot"),
      dialogOpen: document.querySelector("dialog.action-dialog")?.matches(":modal"),
    }));
    console.log(`${name} ${theme} initial focus: ${JSON.stringify(focus)}`);
    assert.equal(focus.id, "plan-title", `${name} ${theme} starts on the neutral dialog heading`);
    assert.equal(focus.dateFocused || focus.slotFocused, false, `${name} ${theme} does not focus a selector`);
    assert.equal(focus.dialogOpen, true, `${name} ${theme} opens a modal dialog`);
    assert.ok(await page.locator("#plan-day").inputValue(), "Plan keeps its default day");
    assert.ok(await page.locator("#plan-slot").inputValue(), "Plan keeps its default slot");
    await page.screenshot({ path: join(screenshots, `${name}-after-${theme}.png`), fullPage: true });

    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plan-day", "Tab from heading reaches the date selector");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plan-slot", "Tab reaches the meal slot selector");
    const dayOptions = await page.locator("#plan-day option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const currentDay = await page.locator("#plan-day").inputValue();
    const nextDay = dayOptions.find((value) => value && value !== currentDay);
    assert.ok(nextDay, "manual day option is available");
    await page.locator("#plan-day").selectOption(nextDay);
    const slotOptions = await page.locator("#plan-slot option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const currentSlot = await page.locator("#plan-slot").inputValue();
    const nextSlot = slotOptions.find((value) => value && value !== currentSlot);
    assert.ok(nextSlot, "manual meal slot option is available");
    await page.locator("#plan-slot").selectOption(nextSlot);
    assert.equal(await page.locator("#plan-day").inputValue(), nextDay, "manual day change is retained");
    assert.equal(await page.locator("#plan-slot").inputValue(), nextSlot, "manual slot change is retained");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plan-day", "Shift+Tab moves through the dialog controls");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.getByRole("button", { name: "Plan meal", exact: true }).evaluate((node) => node === document.activeElement), true, "Shift+Tab wraps within the dialog");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plan-day", "Tab wraps within the dialog");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, "Escape returns focus to the Plan trigger");
  }
  await page.close();
}

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  await inspect(browser, "desktop", false);
  await inspect(browser, "mobile", true);
  console.log(`Issue 68 production browser checks passed; screenshots saved in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve())).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
