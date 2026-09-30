import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const directory = await mkdtemp(join(tmpdir(), "planner-browser-"));
const password = randomUUID();
const env = {
  ...process.env,
  PLANNER_PASSWORD: password,
  PLANNER_ORIGIN: "http://127.0.0.1:3100",
  PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
  FAKE_TODOIST_DELAY_MS: "1800",
  FAKE_TODOIST_FAIL_BEFORE: "0",
  FAKE_TODOIST_LOSE_RESPONSE: "0",
};
execFileSync(
  process.execPath,
  ["node_modules/prisma/dist/prisma.js", "db", "init"],
  { env, stdio: "pipe" },
);
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "3100"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:3100/api/health");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, `Server did not start: ${serverOutput}`);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Meal library" }).waitFor();
  await page.getByRole("searchbox").fill("Browser smoke meal");
  await page.getByRole("button", { name: "Add meal", exact: true }).click();
  await page
    .locator(".library-chip")
    .filter({ hasText: "Browser smoke meal" })
    .hover();
  await page
    .getByRole("button", { name: "Plan Browser smoke meal", exact: true })
    .click();
  await page
    .getByLabel("Meal slot", { exact: true })
    .selectOption({ label: "Lunch" });
  await page.getByRole("button", { name: "Plan meal", exact: true }).click();
  await page
    .getByRole("button", { name: "Saving meal", exact: true })
    .waitFor();
  const bounds = await page
    .locator(".meal-sync-indicator")
    .first()
    .boundingBox();
  assert.ok(
    bounds && bounds.width <= 24 && bounds.height <= 24,
    "Card feedback must stay small",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Saving meal", exact: true })
    .waitFor();
  await page.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  await page
    .getByRole("status", { name: "Meal saved", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    await page
      .locator(".meal-chip")
      .filter({ hasText: "Browser smoke meal" })
      .count(),
    1,
  );
  await page
    .getByRole("button", { name: "Theme: system. Change theme", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Theme: light. Change theme", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "Theme: dark. Change theme", exact: true })
    .waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  assert.equal(await page.locator(".meal-chip").count(), 0);
  await page
    .getByRole("button", { name: "Previous week", exact: true })
    .click();
  const libraryMeal = page
    .locator(".library-chip")
    .filter({ hasText: "Vegetable pasta" });
  await libraryMeal.dragTo(page.locator(".meal-cell").last());
  await page
    .locator(".meal-chip")
    .filter({ hasText: "Vegetable pasta" })
    .waitFor();
  await page.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto("http://127.0.0.1:3100");
  await mobilePage.getByLabel("Password", { exact: true }).fill(password);
  await mobilePage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await mobilePage
    .getByRole("button", { name: "Plan Dal & rice", exact: true })
    .click();
  await mobilePage
    .getByRole("button", { name: "Plan meal", exact: true })
    .click();
  await mobilePage
    .getByRole("button", { name: "Saving meal", exact: true })
    .waitFor();
  await mobilePage
    .getByRole("status", { name: "Meal saved", exact: true })
    .waitFor();
  assert.ok(
    await mobilePage
      .locator(".grid-scroll")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    "Mobile planner scrolls horizontally",
  );
  await mobile.close();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    (await context.request.get("http://127.0.0.1:3100/api/board")).status(),
    401,
  );
  assert.deepEqual(errors, []);
  console.log(
    "HTTP and desktop/mobile browser smoke passed: login, add, Plan, drag, reload pending, spinner/check, theme, navigation, logout.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.once("exit", () => resolve());
  });
  await rm(directory, { recursive: true, force: true });
}
