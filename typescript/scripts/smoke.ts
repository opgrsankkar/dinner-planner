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
  FAKE_TODOIST_FAIL_BEFORE: "2",
  FAKE_TODOIST_LOSE_RESPONSE: "0",
  FAKE_TODOIST_MOVE_FAIL_BEFORE: "2",
  FAKE_TODOIST_DELETE_FAIL_BEFORE: "2",
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
  await page.getByRole("button", { name: /^Retry meal:/ }).waitFor();
  await page.getByRole("button", { name: /^Retry meal:/ }).click();
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
  const pasta = page
    .locator(".meal-chip")
    .filter({ hasText: "Vegetable pasta" });
  await pasta.dragTo(page.locator(".meal-cell").first());
  await page
    .getByRole("button", { name: "Saving meal", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Retry meal:/ }).waitFor();
  await page.getByRole("button", { name: /^Retry meal:/ }).click();
  await page.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".meal-cell")
      .first()
      .locator(".meal-chip")
      .filter({ hasText: "Vegetable pasta" })
      .count(),
    1,
  );
  await page
    .getByRole("button", { name: "Move Browser smoke meal", exact: true })
    .click();
  await page
    .getByLabel("Meal slot", { exact: true })
    .selectOption({ label: "Dinner" });
  await page.getByRole("button", { name: "Move meal", exact: true }).click();
  await page
    .getByRole("button", { name: "Saving meal", exact: true })
    .waitFor();
  await page.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Delete Browser smoke meal", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Saving meal", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Retry meal:/ }).waitFor();
  await page.getByRole("button", { name: /^Retry meal:/ }).click();
  await page
    .locator(".meal-chip")
    .filter({ hasText: "Browser smoke meal" })
    .waitFor({ state: "detached" });
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("heading", { name: "Meal slots", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel("Slot label 1", { exact: true }).fill("Morning");
  await page.waitForTimeout(700); // Board polling must not discard this draft.
  assert.equal(
    await page.getByLabel("Slot label 1", { exact: true }).inputValue(),
    "Morning",
  );
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  assert.equal(
    await page.getByLabel("Slot label 1", { exact: true }).inputValue(),
    "Breakfast",
  );
  await page.getByLabel("Slot label 1", { exact: true }).fill("Morning");
  await page.route("**/api/settings/slots", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic settings save failure" }),
    }),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", { name: "Save failed", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Revert", exact: true }).isEnabled(),
    true,
  );
  await page.unroute("**/api/settings/slots");
  await page.getByLabel("Slot time 1", { exact: true }).fill("08:15");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saving", exact: true }).waitFor();
  const saveBounds = await page.locator(".slot-save-button").boundingBox();
  assert.equal(saveBounds?.width, 112);
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Revert", exact: true })
      .isDisabled(),
    true,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await (
      await context.request.get("http://127.0.0.1:3100/api/board")
    ).json();
    if (
      snapshot.cards.every((card: { state: string }) => card.state === "saved")
    )
      break;
    assert.ok(attempt < 99, "Slot time updates must finish");
    await page.waitForTimeout(100);
  }
  await page
    .getByRole("button", { name: "Reorder Morning", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move Morning down", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await page.reload();
  await page.getByLabel("Slot label 2", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Slot label 2", { exact: true }).inputValue(),
    "Morning",
  );
  await page.getByRole("button", { name: "+ Add slot", exact: true }).click();
  await page.getByLabel("Slot label 4", { exact: true }).fill("Snack");
  await page.getByLabel("Slot time 4", { exact: true }).fill("16:00");
  await page
    .getByRole("button", { name: "Remove slot Snack", exact: true })
    .click();
  assert.equal(await page.locator(".slot-edit-row").count(), 3);
  await page
    .getByRole("button", { name: "Reorder Morning", exact: true })
    .dragTo(page.locator(".slot-edit-row").last());
  assert.equal(
    await page.getByLabel("Slot label 3", { exact: true }).inputValue(),
    "Morning",
  );
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", {
      name: "Remove Vegetable pasta from library",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Remove Vegetable pasta from library",
      exact: true,
    })
    .waitFor({ state: "detached" });
  await page.getByRole("link", { name: "Planner", exact: true }).click();
  await page
    .locator(".meal-chip")
    .filter({ hasText: "Vegetable pasta" })
    .waitFor();
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
  await mobilePage
    .getByRole("button", { name: "Move Dal & rice", exact: true })
    .click();
  await mobilePage
    .getByLabel("Meal slot", { exact: true })
    .selectOption({ label: "Dinner" });
  await mobilePage
    .getByRole("button", { name: "Move meal", exact: true })
    .click();
  await mobilePage
    .getByRole("button", { name: "Saving meal", exact: true })
    .waitFor();
  await mobilePage
    .getByRole("button", { name: "Delete Dal & rice", exact: true })
    .waitFor();
  await mobilePage
    .getByRole("button", { name: "Delete Dal & rice", exact: true })
    .click();
  await mobilePage
    .locator(".meal-chip")
    .filter({ hasText: "Dal & rice" })
    .waitFor({ state: "detached" });
  await mobilePage.getByRole("link", { name: "Settings", exact: true }).click();
  await mobilePage
    .getByLabel("Slot label 1", { exact: true })
    .fill("Mobile draft");
  await mobilePage.getByRole("button", { name: "Revert", exact: true }).click();
  assert.equal(
    await mobilePage.getByLabel("Slot label 1", { exact: true }).inputValue(),
    "Lunch",
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
    "HTTP and desktop/mobile browser smoke passed: login, add, Plan, drag placement/move, button move/delete, retry, reload pending, spinner/check, Settings Save/Revert/failure/reorder, library removal preserving plan, theme, navigation, logout.",
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
