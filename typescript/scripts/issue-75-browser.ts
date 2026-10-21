import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-75-"));
const screenshots = resolve(process.env.ISSUE75_SCREENSHOT_DIR ?? ".local/issue-75/after");
const password = `synthetic-${crypto.randomUUID()}`;
const port = "3115";
const origin = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  TODOIST_MODE: "fake",
  ALLOWED_HOSTS: "127.0.0.1,localhost",
  COOKIE_SECURE: "false",
  DATABASE_PATH: join(directory, "planner.sqlite"),
  APP_PASSWORD: password,
  PORT: port,
  HOST: "127.0.0.1",
  PLANNER_ORIGIN: origin,
  PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
  FAKE_TODOIST_DELAY_MS: "0",
};
const server = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: root, env, stdio: "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function login(page: Page) {
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production server exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Production server did not become ready");
}

const plannerNames = (page: Page) => page.locator(".library-chip-name").allTextContents();

try {
  await mkdir(screenshots, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });

  for (const width of [1440, 390]) {
    const mobile = width === 390;
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 844 : 900 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: theme,
      });
      const page = await context.newPage();
      await login(page);
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
      const tag = `${mobile ? "mobile" : "desktop"}-${theme}`;

      const name = `Issue 75 meal ${crypto.randomUUID().slice(0, 8)}`;
      let initialFirst: string;
      if (mobile) {
        // Phones have no side panel; the cell "+" dialog lists the library instead.
        await page.getByRole("button", { name: "Next week", exact: true }).click();
        const add = page.getByRole("dialog", { name: /^Add to / });
        const options = add.locator(".add-meal-options button:not(.add-meal-create)");
        await page.locator(".cell-add-button").first().tap();
        const initial = await options.allInnerTexts();
        assert.ok(initial.length >= 3, `${tag}: seeded library is listed`);
        initialFirst = initial[0];
        await page.locator("#add-meal-search").fill(name);
        await add.locator(".add-meal-create").tap();
        await page.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
        await page.locator(".meal-chip").filter({ hasText: name }).waitFor();
        await page.locator(".cell-add-button").nth(1).tap();
        await add.waitFor();
        const ordered = await options.allInnerTexts();
        assert.equal(ordered[0], name, `${tag}: newly added meal appears at the top of the + list`);
        assert.equal(ordered.at(-1), initial.at(-1), `${tag}: existing meals keep their relative order`);
        assert.equal(ordered.length, initial.length + 1, `${tag}: add appends exactly one meal`);
        await page.screenshot({ path: join(screenshots, `${tag}-new-meal-top.png`), fullPage: true });
        await page.keyboard.press("Escape");
      } else {
        const initial = await plannerNames(page);
        assert.ok(initial.length >= 3, `${tag}: seeded library is visible`);
        initialFirst = initial[0];

        await page.getByRole("searchbox").fill(name);
        await page.getByRole("button", { name: "Add meal", exact: true }).click();
        await page.getByText(`Added ${name} to the meal library.`).waitFor();
        await page.locator(".library-chip-name").filter({ hasText: name }).waitFor();

        const ordered = await plannerNames(page);
        assert.equal(ordered[0], name, `${tag}: newly added meal appears at the top of the planner side panel`);
        assert.equal(ordered.at(-1), initial.at(-1), `${tag}: existing meals keep their relative order`);
        assert.equal(ordered.length, initial.length + 1, `${tag}: add appends exactly one meal`);
        await page.screenshot({ path: join(screenshots, `${tag}-new-meal-top.png`), fullPage: true });

        // The new top meal must be immediately usable without scrolling or searching.
        await page.getByRole("button", { name: `Plan ${name}`, exact: true }).click();
        await page.getByRole("dialog", { name: `Plan ${name}` }).waitFor();
        await page.getByLabel("Day", { exact: true }).selectOption({ index: 1 });
        await page.getByLabel("Meal slot", { exact: true }).selectOption({ label: "Lunch" });
        await page.getByRole("button", { name: "Plan meal", exact: true }).click();
        await page.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
        await page.locator(".meal-chip").filter({ hasText: name }).waitFor();
      }

      // Settings keeps its own server-driven order; the side-panel float must not leak.
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Meal library", exact: true }).click();
      const settingsNames = await page.locator(".folio-library-name").allTextContents();
      assert.equal(settingsNames[0], initialFirst, `${tag}: Settings library keeps its original first meal`);
      assert.ok(settingsNames.includes(name), `${tag}: Settings library still lists the new meal`);
      assert.notEqual(settingsNames[0], name, `${tag}: Settings ordering is unchanged by the planner float`);
      await page.screenshot({ path: join(screenshots, `${tag}-settings-order-unchanged.png`), fullPage: true });

      await context.close();
    }
  }
  console.log(`Issue 75 planner-side-panel checks passed at 1440/390 light+dark; screenshots in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
