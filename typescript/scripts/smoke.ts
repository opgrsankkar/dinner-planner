import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  PORT: "3100",
  HOST: "127.0.0.1",
  PLANNER_ORIGIN: "http://127.0.0.1:3100",
  PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
  FAKE_TODOIST_DELAY_MS: "1800",
  FAKE_TODOIST_FAIL_BEFORE: "2",
  FAKE_TODOIST_LOSE_RESPONSE: "0",
  FAKE_TODOIST_MOVE_FAIL_BEFORE: "2",
  FAKE_TODOIST_DELETE_FAIL_BEFORE: "2",
};
const refused = spawnSync(process.execPath, ["scripts/serve.mjs"], {
  env: {
    ...env,
    TODOIST_MODE: "live",
    DATABASE_PATH: join(directory, "unconfigured.sqlite"),
    PLANNER_DB: join(directory, "unconfigured.sqlite"),
  },
  encoding: "utf8",
  timeout: 30000,
});
assert.notEqual(
  refused.status,
  0,
  "Live startup must refuse missing credentials",
);
assert.match(refused.stderr, /Todoist credentials are required/);
assert.equal(
  existsSync(env.FAKE_TODOIST_DB),
  false,
  "Live config never falls back to fake",
);
const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
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
      const response = await fetch("http://127.0.0.1:3100/healthz");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, `Server did not start: ${serverOutput}`);
  assert.equal(
    existsSync(env.FAKE_TODOIST_DB),
    false,
    "Public health does not initialize the provider",
  );
  assert.equal((await fetch("http://127.0.0.1:3100/api/board")).status, 401);
  const css = await fetch("http://127.0.0.1:3100/static/app.css");
  assert.equal(css.headers.get("content-type"), "text/css");
  assert.ok((await css.text()).includes("meal-grid"));
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
  // Exercise history classification and integration warnings through synthetic
  // HTTP snapshots; this is UI evidence, separately from adapter contract tests.
  let synthetic = true;
  await page.route("**/api/board?*", async (route) => {
    const response = await route.fetch();
    const board = await response.json();
    if (synthetic) {
      const week = new URL(route.request().url()).searchParams.get("week")!;
      board.integrationError = "Synthetic Todoist unavailable";
      board.cards.push({
        id: "real-completed",
        projectId: board.projectId,
        name: "History meal",
        date: week,
        time: board.slots[0].time,
        slotId: board.slots[0].id,
        requestId: "",
        completed: true,
        state: "saved",
        error: "",
        confirmedAt: 0,
      });
      board.cards.push({
        id: "undated",
        projectId: board.projectId,
        name: "Undated meal",
        date: "",
        time: "",
        requestId: "",
        dueError: "No due date/time",
        state: "saved",
        error: "",
        confirmedAt: 0,
      });
      board.cards.push({
        id: "unmatched",
        projectId: board.projectId,
        name: "Odd time",
        date: week,
        time: "09:37",
        requestId: "",
        state: "saved",
        error: "",
        confirmedAt: 0,
      });
    }
    await route.fulfill({ response, json: board });
  });
  await page
    .locator(".meal-chip")
    .filter({ hasText: "History meal" })
    .waitFor();
  const completed = page
    .locator(".meal-chip")
    .filter({ hasText: "History meal" });
  assert.equal(await completed.getAttribute("draggable"), "false");
  assert.equal(await completed.locator("button").count(), 0);
  await page
    .getByText("Synthetic Todoist unavailable", { exact: false })
    .waitFor();
  await page
    .getByText("Undated meal (No due date/time)", { exact: false })
    .waitFor();
  await page.locator(".meal-chip").filter({ hasText: "Odd time" }).waitFor();
  await page
    .getByRole("button", { name: "Previous week", exact: true })
    .click();
  await page
    .locator(".meal-chip")
    .filter({ hasText: "History meal" })
    .waitFor();
  synthetic = false;
  await page.unroute("**/api/board?*");
  await page.getByRole("button", { name: "This week", exact: true }).click();
  await page
    .locator(".meal-chip")
    .filter({ hasText: "History meal" })
    .waitFor({ state: "detached" });
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
  for (const preference of ["light", "dark"] as const) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: /System/ }).click();
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('.theme-option input')?.checked);
    await page.waitForFunction(() => document.documentElement.dataset.theme ===
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    await page.getByRole("link", { name: "← Back to plan", exact: true }).click();
    await page.emulateMedia({ colorScheme: preference });
    await page.reload();
    const opposite = preference === "dark" ? "light" : "dark";
    const toggle = page.getByRole("button", { name: `Switch to ${opposite} theme`, exact: true });
    await toggle.waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), preference);
    assert.ok(await toggle.locator("svg").isVisible());
    const iconHref = await toggle.locator("use").getAttribute("href");
    assert.equal(iconHref, `/static/lucide-icons.svg#${preference === "dark" ? "moon" : "sun"}`);
    const sprite = await (await context.request.get("http://127.0.0.1:3100/static/lucide-icons.svg")).text();
    assert.ok(await page.evaluate(({ sprite, id }) => {
      const document = new DOMParser().parseFromString(sprite, "image/svg+xml");
      return !!document.getElementById(id)?.querySelector("path,circle,line,polyline");
    }, { sprite, id: preference === "dark" ? "moon" : "sun" }), "Theme icon references a populated sprite symbol");
    await toggle.click();
    await page.getByRole("button", { name: `Switch to ${preference} theme`, exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: `Switch to ${preference} theme`, exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), opposite);
    const snapshot = await (await context.request.get("http://127.0.0.1:3100/api/board")).json();
    assert.equal(snapshot.settings.theme, opposite);
  }
  const longName = "Long synthetic meal with vegetables lentils rice and accompaniments " + "x".repeat(50);
  await page.getByRole("searchbox").fill(longName);
  await page.getByRole("button", { name: "Add meal", exact: true }).click();
  await page.getByRole("searchbox").fill("");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator(".library-chip-name").filter({ hasText: longName }).waitFor();
    await page.waitForTimeout(500);
    assert.ok(await page.locator(".library-list").evaluate((list) => {
      const chips = [...list.querySelectorAll<HTMLElement>(".library-chip")];
      return chips.every((chip) => {
        const box = chip.getBoundingClientRect();
        const name = chip.querySelector<HTMLElement>(".library-chip-name")!;
        const text = name.getBoundingClientRect();
        return text.top >= box.top && text.bottom <= box.bottom && name.scrollWidth <= name.clientWidth + 1 &&
          chips.every((other) => {
            if (other === chip) return true;
            const next = other.getBoundingClientRect();
            return box.right <= next.left || next.right <= box.left || box.bottom <= next.top || next.bottom <= box.top;
          });
      });
    }), "Long names stay within chips without overlapping rows");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
  assert.equal(await page.getByRole("navigation", { name: "Week navigation" }).count(), 0);
  await page.getByRole("link", { name: "← Back to plan", exact: true }).waitFor();
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
  await page.getByRole("link", { name: "← Back to plan", exact: true }).click();
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
  const dragMeal = page
    .locator(".meal-chip")
    .filter({ hasText: "Vegetable pasta" });
  await dragMeal.waitFor();
  await dragMeal.dragTo(
    page.getByLabel("Delete dragged planned meal", { exact: true }),
    { force: true },
  );
  await page.getByRole("dialog", { name: "Confirm meal deletion" }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await dragMeal.count(), 1);
  await dragMeal.dragTo(
    page.getByLabel("Delete dragged planned meal", { exact: true }),
    { force: true },
  );
  await page.getByRole("button", { name: "Delete meal", exact: true }).click();
  await dragMeal.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    (await context.request.get("http://127.0.0.1:3100/api/board")).status(),
    401,
  );
  assert.deepEqual(errors, []);
  console.log(
    "HTTP and desktop/mobile browser smoke passed: login, add, Plan, drag placement/move, button move/delete, retry, reload pending, spinner/check, Settings Save/Revert/failure/reorder, library removal preserving plan, theme, completed history/warnings, navigation, drag delete confirmation, logout.",
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
