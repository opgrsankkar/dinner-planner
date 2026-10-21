// Phone touch drag regression: native scrolling from cards, floating ghost,
// edge auto-scroll, library meals dragged onto the board, and on-screen trash.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-mobile-touch-dnd-"));
const screenshots = process.env.MOBILE_TOUCH_DND_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-mobile-touch-dnd");
await mkdir(screenshots, { recursive: true });
const password = `synthetic-${crypto.randomUUID()}`;
const origin = "http://127.0.0.1:3127";
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
    PORT: "3127",
    HOST: "127.0.0.1",
    PLANNER_ORIGIN: origin,
    PLANNER_DB: join(directory, "planner.sqlite"),
    FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
    FAKE_TODOIST_DELAY_MS: "0",
  },
});
let browser: Browser | undefined;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
type Point = { x: number; y: number };

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
async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", point?: Point) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
}
async function slide(cdp: CDPSession, from: Point, to: Point, steps = 8) {
  for (let step = 1; step <= steps; step++) {
    await touch(cdp, "touchMove", { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps });
    await sleep(16);
  }
}
async function center(page: Page, selector: string): Promise<Point> {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} is rendered`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
const gridLeft = (page: Page) => page.evaluate(() => document.querySelector(".grid-scroll")!.scrollLeft);
const showCard = (page: Page, id: string) => page.evaluate((cardId) => {
  window.scrollTo(0, 0);
  const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
  grid.scrollLeft = document.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`)!.closest("td")!.offsetLeft - 70;
}, id);

try {
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
  // Next week keeps every slot in the future, so cards stay draggable.
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  await page.waitForFunction(() => {
    const first = document.querySelector<HTMLElement>("tbody .meal-cell")?.dataset.date ?? "";
    return first > new Date().toISOString().slice(0, 10);
  });
  await page.evaluate(async () => {
    const week = document.querySelector<HTMLElement>("tbody .meal-cell")!.dataset.date!;
    const board = await (await fetch(`/api/board?week=${week}`)).json();
    const dates = Array.from(document.querySelectorAll<HTMLElement>("tbody tr:first-child .meal-cell")).map((cell) => cell.dataset.date!);
    let index = 0;
    for (const date of dates.slice(3)) {
      for (const slot of board.slots) {
        const meal = board.library[index++ % board.library.length];
        await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": board.csrf },
          body: JSON.stringify({ requestId: crypto.randomUUID(), mealId: meal.id, slotId: slot.id, date }),
        });
      }
    }
  });
  await page.waitForFunction(() => document.querySelectorAll(".meal-chip[role=button]").length >= 4 && !document.querySelector(".meal-chip.is-sync-pending"), null, { timeout: 15000 });
  const firstCard = (await page.locator(".meal-chip[role=button]").first().getAttribute("data-card-id"))!;

  // A swipe that starts on a card scrolls natively instead of being blocked or emulated.
  assert.notEqual(await page.locator(`[data-card-id="${firstCard}"]`).evaluate((node) => getComputedStyle(node).touchAction), "none", "cards allow native panning");
  await showCard(page, firstCard);
  const before = await gridLeft(page);
  const start = await center(page, `[data-card-id="${firstCard}"]`);
  await touch(cdp, "touchStart", start);
  await slide(cdp, start, { x: start.x - 60, y: start.y }, 5);
  await touch(cdp, "touchEnd");
  await sleep(300);
  assert.ok((await gridLeft(page)) > before + 20, "swiping from a card scrolls the board");
  assert.equal(await page.locator("dialog[open]").count(), 0, "scrolling does not open the card dialog");
  assert.equal(await page.locator(".touch-drag-ghost").count(), 0, "scrolling does not start a drag");

  // Hold, then drag: a ghost floats above the finger and the drop moves the card.
  await showCard(page, firstCard);
  const sourceCell = await page.locator(`[data-card-id="${firstCard}"]`).evaluate((node) => {
    const cell = node.closest<HTMLElement>("td")!;
    return { date: cell.dataset.date!, slot: cell.dataset.slotId! };
  });
  const target = await page.evaluate((source) => {
    const cell = Array.from(document.querySelectorAll<HTMLElement>(".meal-cell")).find((td) => td.dataset.date! > source.date && td.dataset.slotId === source.slot && td.getBoundingClientRect().right <= innerWidth)!;
    const box = cell.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.bottom - 12, date: cell.dataset.date! };
  }, sourceCell);
  const from = await center(page, `[data-card-id="${firstCard}"]`);
  await touch(cdp, "touchStart", from);
  await sleep(550);
  await slide(cdp, from, target);
  const ghost = await page.locator(".touch-drag-ghost").boundingBox();
  assert.ok(ghost && ghost.y + ghost.height < target.y, "ghost floats above the finger");
  assert.equal(await page.locator(`.meal-cell.touch-drop-hover[data-date="${target.date}"]`).count(), 1, "cell under the finger is highlighted");
  const trash = await page.locator(".trash-drop-target").boundingBox();
  assert.ok(trash && trash.y >= 0 && trash.y + trash.height <= 667, "trash is on screen during a touch drag");
  await page.screenshot({ path: join(screenshots, "planned-drag.png") });
  await touch(cdp, "touchEnd");
  await page.waitForFunction(({ id, date }) => document.querySelector(`[data-card-id="${id}"]`)?.closest<HTMLElement>("td")?.dataset.date === date, { id: firstCard, date: target.date }, { timeout: 10000 });
  assert.equal(await page.locator(".touch-drag-ghost").count(), 0, "ghost is removed after the drop");
  assert.equal(await page.locator("dialog[open]").count(), 0, "a drop does not open the card dialog");

  // Holding near the left edge scrolls the board towards earlier days.
  await page.waitForSelector(`[data-card-id="${firstCard}"]:not(.is-sync-pending)[role=button]`);
  await showCard(page, firstCard);
  const edgeStart = await center(page, `[data-card-id="${firstCard}"]`);
  const scrolledFrom = await gridLeft(page);
  await touch(cdp, "touchStart", edgeStart);
  await sleep(550);
  await slide(cdp, edgeStart, { x: 24, y: edgeStart.y });
  await sleep(800);
  const scrolledTo = await gridLeft(page);
  await slide(cdp, { x: 24, y: edgeStart.y }, { x: 24, y: 12 }, 2);
  await touch(cdp, "touchEnd");
  assert.ok(scrolledTo < scrolledFrom - 100, `edge hold auto-scrolls the board (${scrolledFrom} -> ${scrolledTo})`);

  // A library meal can be held and dragged onto the board; the page scrolls up to it.
  await page.evaluate(() => { document.querySelector(".grid-scroll")!.scrollLeft = 0; window.scrollTo(0, document.documentElement.scrollHeight); });
  await sleep(150);
  const libraryMeal = (await page.locator(".library-chip").first().getAttribute("aria-label"))!.replace(/^Plan /, "");
  const cardCount = await page.locator(".meal-chip[data-card-id]").count();
  const pageBefore = await page.evaluate(() => scrollY);
  const library = await center(page, ".library-chip");
  await touch(cdp, "touchStart", library);
  await sleep(550);
  await slide(cdp, library, { x: 200, y: 20 }, 10);
  let empty: (Point & { date: string; slot: string }) | null = null;
  for (let attempt = 0; attempt < 150 && !empty; attempt++) {
    await sleep(30);
    empty = await page.evaluate(() => {
      const cell = Array.from(document.querySelectorAll<HTMLElement>(".meal-cell")).find((td) => {
        const box = td.getBoundingClientRect();
        return td.dataset.slotId !== "unassigned" && !td.querySelector(".meal-chip") && box.top > 70 && box.bottom < innerHeight - 140 && box.left > 70 && box.right < innerWidth;
      });
      if (!cell) return null;
      const box = cell.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, date: cell.dataset.date!, slot: cell.dataset.slotId! };
    });
  }
  assert.ok(empty, "dragging to the top edge scrolls the board into view");
  assert.ok((await page.evaluate(() => scrollY)) < pageBefore, "page auto-scrolled upward");
  await slide(cdp, { x: 200, y: 20 }, empty, 6);
  assert.equal(await page.locator(`.meal-cell[data-date="${empty.date}"][data-slot-id="${empty.slot}"] .meal-chip-preview`).textContent(), libraryMeal, "library drop preview appears in the target cell");
  await page.screenshot({ path: join(screenshots, "library-drag.png") });
  await touch(cdp, "touchEnd");
  await page.locator(`.meal-cell[data-date="${empty.date}"][data-slot-id="${empty.slot}"] .meal-chip[data-card-id]`).filter({ hasText: libraryMeal }).waitFor();
  assert.equal(await page.locator(".meal-chip[data-card-id]").count(), cardCount + 1, "library touch drop plans exactly one meal");
  assert.equal(await page.locator("dialog[open]").count(), 0, "library drop does not open the Plan dialog");

  // Dropping a planned card on the pinned trash asks for confirmation.
  await page.waitForFunction(() => !document.querySelector(".meal-chip.is-sync-pending"));
  const trashCard = (await page.locator(".meal-chip[role=button]").first().getAttribute("data-card-id"))!;
  await showCard(page, trashCard);
  const trashFrom = await center(page, `[data-card-id="${trashCard}"]`);
  await touch(cdp, "touchStart", trashFrom);
  await sleep(550);
  const trashCenter = await center(page, ".trash-drop-target");
  await slide(cdp, trashFrom, trashCenter);
  assert.equal(await page.evaluate(() => document.body.classList.contains("trash-hover")), true, "trash highlights under the finger");
  await touch(cdp, "touchEnd");
  await page.getByRole("dialog", { name: "Confirm meal deletion" }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Taps still open the non-drag alternatives (after the brief post-drop click guard).
  await sleep(500);
  await showCard(page, trashCard);
  const tapCard = await center(page, `[data-card-id="${trashCard}"]`);
  await page.touchscreen.tap(tapCard.x, tapCard.y);
  await page.getByRole("dialog", { name: /^Move / }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".library-chip").first().scrollIntoViewIfNeeded();
  const tapLibrary = await center(page, ".library-chip");
  await page.touchscreen.tap(tapLibrary.x, tapLibrary.y);
  await page.getByRole("dialog", { name: `Plan ${libraryMeal}` }).waitFor();
  await page.keyboard.press("Escape");

  // Once nothing is saving, the board stops polling twice a second.
  await page.waitForFunction(() => !document.querySelector(".meal-chip.is-sync-pending, .meal-sync-indicator[role=status]"));
  await sleep(600);
  let boardPolls = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/board") boardPolls++; });
  await sleep(3000);
  assert.ok(boardPolls <= 1, `idle board polls slowly (${boardPolls} requests in 3s)`);

  console.log(`Mobile touch drag checks passed; screenshots in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill();
}
