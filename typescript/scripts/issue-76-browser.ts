import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-76-"));
const screenshots = resolve(process.env.ISSUE76_SCREENSHOT_DIR ?? ".local/issue-76");
const password = `synthetic-${crypto.randomUUID()}`;
const port = "3116";
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

function cellAt(page: Page, dayIndex: number): Locator {
  return page.locator(".meal-cell[data-date][data-slot-id]").nth(dayIndex);
}

async function chipNamed(page: Page, name: string): Promise<Locator> {
  return page.locator(".library-chip").filter({ has: page.locator(".library-chip-name", { hasText: name }) });
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// The terminal move can skip a drag-over dispatch, so settle just inside the target.
async function moveAndSettle(page: Page, to: { x: number; y: number }) {
  await page.mouse.move(to.x, to.y, { steps: 14 });
  const settle = { x: to.x + 2, y: to.y };
  await page.mouse.move(settle.x, settle.y, { steps: 2 });
  return settle;
}

async function pressAndDragTo(page: Page, source: Locator, target: Locator) {
  const from = await center(source);
  const to = await center(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 14, from.y + 14, { steps: 4 });
  return moveAndSettle(page, to);
}

async function releaseAt(page: Page, point: { x: number; y: number }) {
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await page.mouse.up();
}

const previewIn = (page: Page, dayIndex: number) => cellAt(page, dayIndex).locator(".meal-chip-preview");
const realChips = (page: Page) => page.locator(".meal-chip:not(.meal-chip-preview)");

try {
  await mkdir(screenshots, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });

  // Desktop: real held-mouse HTML5 drag with a visible preview.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const page = await context.newPage();
    await login(page);
    const cssHref = await page.locator('link[rel="stylesheet"]').first().getAttribute("href");
    assert.match(cssHref ?? "", /app\.css\?v=issue76/, "planner loads the versioned stylesheet");

    const names = await page.locator(".library-chip-name").allTextContents();
    assert.ok(names.length >= 3, "seeded library is available");
    const first = names[0]!;
    const second = names[1]!;
    const source = await chipNamed(page, first);

    // Held drag shows the ghost in the hovered cell before release.
    const held = await pressAndDragTo(page, source, cellAt(page, 0));
    assert.ok(await source.evaluate((el) => el.classList.contains("is-dragging")), "native drag started");
    const hovered = await page.evaluate(({ x, y }) => {
      const cell = document.elementFromPoint(x, y)?.closest(".meal-cell");
      return cell ? { date: (cell as HTMLElement).dataset.date, slotId: (cell as HTMLElement).dataset.slotId } : null;
    }, held);
    assert.ok(hovered, "pointer is over a calendar cell");
    const ghost = previewIn(page, 0);
    await ghost.waitFor({ state: "visible", timeout: 3000 });
    assert.equal((await ghost.locator(".meal-chip-name").innerText()).trim(), first, "ghost shows the dragged meal name");
    const ghostCell = await ghost.evaluate((el) => {
      const cell = el.closest(".meal-cell") as HTMLElement | null;
      return cell ? { date: cell.dataset.date, slotId: cell.dataset.slotId } : null;
    });
    assert.deepEqual(ghostCell, hovered, "ghost sits in the cell under the pointer (date and slot)");
    const ghostStyle = await ghost.evaluate((el) => {
      const style = getComputedStyle(el);
      return { border: style.borderTopStyle, pointer: style.pointerEvents };
    });
    assert.equal(ghostStyle.border, "dashed", "versioned stylesheet applies the ghost outline");
    assert.equal(ghostStyle.pointer, "none", "ghost ignores pointer events");
    assert.ok(await cellAt(page, 0).evaluate((el) => el.classList.contains("drag-drop-hover")), "hovered cell is marked");
    assert.equal(await realChips(page).count(), 0, "no meal is written while the drag is still held");
    await page.screenshot({ path: join(screenshots, "desktop-drag-ghost-held.png"), fullPage: true });

    // Moving to another cell clears the previous ghost and previews the new one.
    await moveAndSettle(page, await center(cellAt(page, 1)));
    await previewIn(page, 1).waitFor({ state: "visible", timeout: 3000 });
    assert.equal(await previewIn(page, 0).count(), 0, "leaving a cell clears its ghost");
    assert.equal(await realChips(page).count(), 0, "moving the ghost never writes data");

    // Leaving the calendar and cancelling with Escape clears the ghost, then releases.
    await moveAndSettle(page, { x: 720, y: 120 });
    await page.waitForFunction(() => !document.querySelector(".meal-chip-preview"));
    assert.equal(await page.locator(".meal-chip-preview").count(), 0, "leaving the calendar clears the ghost");
    await moveAndSettle(page, await center(cellAt(page, 0)));
    await previewIn(page, 0).waitFor({ state: "visible", timeout: 3000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".meal-chip-preview"));
    assert.equal(await page.locator(".meal-chip-preview").count(), 0, "Escape cancels the ghost");
    await page.mouse.up();
    assert.equal(await realChips(page).count(), 0, "cancelled drag creates no meal");

    // A real drop creates exactly one meal and no lingering ghost.
    const destination = cellAt(page, 0);
    await pressAndDragTo(page, source, destination);
    await previewIn(page, 0).waitFor({ state: "visible", timeout: 3000 });
    await releaseAt(page, await center(destination));
    await page.waitForFunction(() => !document.querySelector(".meal-chip-preview"));
    assert.equal(await page.locator(".meal-chip-preview").count(), 0, "drop clears the ghost");
    await page.getByRole("status", { name: "Meal saved", exact: true }).first().waitFor();
    const placed = destination.locator(".meal-chip").filter({ hasText: first });
    await placed.waitFor({ timeout: 5000 });
    assert.equal(await realChips(page).count(), 1, "drop creates exactly one meal");

    // Multi-meal cell: a second library meal previews beside the existing card.
    const sourceTwo = await chipNamed(page, second);
    await pressAndDragTo(page, sourceTwo, destination);
    await previewIn(page, 0).waitFor({ state: "visible", timeout: 3000 });
    assert.equal((await previewIn(page, 0).locator(".meal-chip-name").innerText()).trim(), second, "second ghost shows its own meal");
    assert.equal(await destination.locator(".meal-chip:not(.meal-chip-preview)").count(), 1, "existing meal stays visible under the ghost");
    await page.screenshot({ path: join(screenshots, "desktop-drag-ghost-multi-meal.png"), fullPage: true });
    await releaseAt(page, await center(destination));
    await page.waitForFunction(() => !document.querySelector(".meal-chip-preview"));
    await destination.locator(".meal-chip").filter({ hasText: second }).waitFor({ timeout: 5000 });
    assert.equal(await realChips(page).count(), 2, "multi-meal drop adds exactly one more meal");
    assert.equal(await page.locator(".library-chip-name").filter({ hasText: first }).count(), 1, "dragging does not consume the library meal");

    // Non-drag alternative: keyboard activation still opens the plan dialog.
    const keyboardSource = await chipNamed(page, first);
    await keyboardSource.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: `Plan ${first}` }).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("dialog", { name: `Plan ${first}` }).waitFor({ state: "hidden" });

    await context.close();
  }

  // Mobile/touch: preview is mouse-only; tap fallback stays intact.
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await login(page);
    // Phones plan from a cell's "+" (the library panel is hidden).
    await page.locator(".cell-add-button").first().tap();
    await page.getByRole("dialog", { name: /^Add to / }).waitFor();
    assert.equal(await page.locator(".meal-chip-preview").count(), 0, "touch interaction creates no drag ghost");
    await page.screenshot({ path: join(screenshots, "mobile-touch-plan-dialog.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await context.close();
  }

  console.log(`Issue 76 drag-ghost checks passed; screenshots in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
