// After npm run build: node --import tsx scripts/delete-after-confirm-browser.ts
// Runs the production server against the in-memory mock LiveTodoist transport
// (scripts/mock-todoist.mjs) with synthetic data only. No real Todoist account
// or network is touched. Covers: plan a meal, wait for the saved check, delete
// it immediately (long before the 15s listing cache would expire), and confirm
// it stays gone after a reload.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const screenshots = resolve(
  process.env.DELETE_CONFIRM_SCREENSHOT_DIR ?? ".local/delete-confirm",
);
const directory = await mkdtemp(join(tmpdir(), "planner-delete-confirm-"));
const password = `synthetic-${crypto.randomUUID()}`;
const port = "3122";
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [
    "--import",
    pathToFileURL(resolve(root, "scripts/mock-todoist.mjs")).href,
    "scripts/serve.mjs",
  ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      TODOIST_MODE: "live",
      TODOIST_TOKEN: "synthetic-token",
      ALLOWED_HOSTS: "127.0.0.1,localhost",
      COOKIE_SECURE: "false",
      DATABASE_PATH: join(directory, "planner.sqlite"),
      APP_PASSWORD: password,
      PORT: port,
      HOST: "127.0.0.1",
      PLANNER_ORIGIN: origin,
      PLANNER_DB: join(directory, "planner.sqlite"),
    },
    stdio: "ignore",
  },
);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Production server exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Production server did not become ready");
}

async function login(page: Page) {
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("complementary", { name: "Meal library", exact: true })
    .waitFor();
}

function chipAt(page: Page, date: string, slotId: string) {
  return page.locator(
    `.meal-cell[data-date="${date}"][data-slot-id="${slotId}"] .meal-chip`,
  );
}

async function plannedPlacement(page: Page, name: string) {
  const chip = page
    .locator(".library-chip")
    .filter({ has: page.locator(".library-chip-name", { hasText: name }) })
    .first();
  await chip.click();
  const dialog = page.getByRole("dialog", { name: `Plan ${name}` });
  await dialog.waitFor();
  const days = await dialog
    .locator("#plan-day option")
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter(Boolean),
    );
  const slots = await dialog
    .locator("#plan-slot option")
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter(Boolean),
    );
  assert.ok(slots.length >= 1, "a meal slot is available");
  const future = [...days].filter((day) => day > today).sort()[0];
  if (future) {
    await dialog.locator("#plan-day").selectOption(future);
    await dialog.locator("#plan-slot").selectOption(slots[0]!);
    await dialog.getByRole("button", { name: "Plan meal", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    return { date: future, slotId: slots[0]! };
  }
  // The displayed week has no future day (e.g. today is Sunday); use next week.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  return plannedPlacement(page, name);
}

try {
  await mkdir(screenshots, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await login(page);
    const name = `Delete confirm ${Date.now()}`;
    await page.getByLabel("Search or type a meal name").fill(name);
    await page.getByRole("button", { name: "Add meal", exact: true }).click();
    await page
      .locator(".library-chip-name")
      .filter({ hasText: name })
      .waitFor();

    const { date, slotId } = await plannedPlacement(page, name);
    const card = chipAt(page, date, slotId);
    await card.waitFor({ state: "visible" });
    // The meal was just created; the saved check confirms the write landed.
    await expect(card.locator('[aria-label="Meal saved"]')).toBeVisible({
      timeout: 10000,
    });
    await page.screenshot({
      path: join(screenshots, "saved-check.png"),
      fullPage: true,
    });

    // Delete immediately while the active listing cache is still stale.
    await card.click();
    const action = page.getByRole("dialog", { name: `Move ${name}` });
    await action.waitFor();
    await action.getByRole("button", { name: "Delete meal", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm meal deletion" });
    await confirm.waitFor();
    await confirm
      .getByRole("button", { name: "Delete meal", exact: true })
      .click();
    await confirm.waitFor({ state: "hidden" });
    await expect(card).toHaveCount(0, { timeout: 10000 });
    assert.ok(
      !(await page.locator(".error-banner").allTextContents()).some((text) =>
        /missing, completed/.test(text),
      ),
      "immediate delete must not report the meal as missing",
    );
    await page.screenshot({
      path: join(screenshots, "after-immediate-delete.png"),
      fullPage: true,
    });

    await page.reload();
    await page
      .getByRole("complementary", { name: "Meal library", exact: true })
      .waitFor();
    await expect(chipAt(page, date, slotId)).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log(
      `Delete-after-confirm browser regression passed; screenshots in ${screenshots}`,
    );
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null)
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
