import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-66-"));
const screenshots = process.env.ISSUE66_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-issue-66");
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
  let actionDialog = desktop.getByRole("dialog", { name: `Plan ${plannedName}` });
  await actionDialog.waitFor();
  assert.equal(await actionDialog.getByRole("button", { name: "Delete meal" }).count(), 0, "planning an unplanned library meal has no delete action");
  await desktop.screenshot({ path: join(screenshots, "desktop-light-plan-dialog.png"), fullPage: true });
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await actionDialog.waitFor({ state: "hidden" });
  await assertFocusOn(desktop, libraryMeal, "closing Plan returns focus to its library button");

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
  actionDialog = desktop.getByRole("dialog", { name: `Move ${plannedName}` });
  await actionDialog.waitFor();
  assert.equal(await actionDialog.getByRole("button", { name: "Delete meal" }).count(), 1, "planned-meal actions offer confirmed deletion");
  await desktop.screenshot({ path: join(screenshots, "desktop-light-actions.png"), fullPage: true });
  for (let index = 0; index < 6; index++) await desktop.keyboard.press("Tab");
  assert.equal(await actionDialog.evaluate((node) => node.contains(document.activeElement)), true, "Tab remains in the modal dialog");
  await desktop.keyboard.press("Escape");
  await actionDialog.waitFor({ state: "hidden" });
  await assertFocusOn(desktop, planned, "closing Move returns focus to its planned card");

  // Opening Plan after a planned-card dialog must replace the prior focus target.
  await libraryMeal.click();
  actionDialog = desktop.getByRole("dialog", { name: `Plan ${plannedName}` });
  await actionDialog.waitFor();
  assert.equal(await actionDialog.getByRole("button", { name: "Delete meal" }).count(), 0, "Plan remains non-destructive after Move was opened");
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await actionDialog.waitFor({ state: "hidden" });
  await assertFocusOn(desktop, libraryMeal, "Cancel returns focus to the current library button, not a previous meal card");

  await planned.focus();
  await desktop.keyboard.press("Enter");
  actionDialog = desktop.getByRole("dialog", { name: `Move ${plannedName}` });
  await actionDialog.waitFor();
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  const confirmation = desktop.getByRole("dialog", { name: "Confirm meal deletion" });
  await confirmation.waitFor();
  await desktop.keyboard.press("Shift+Tab");
  assert.equal(await desktop.getByRole("button", { name: "Delete meal", exact: true }).evaluate((node) => node === document.activeElement), true, "delete confirmation wraps Shift+Tab");
  await desktop.keyboard.press("Tab");
  assert.equal(await desktop.getByRole("button", { name: "Cancel", exact: true }).evaluate((node) => node === document.activeElement), true, "delete confirmation wraps Tab");
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  await assertFocusOn(desktop, planned, "canceling delete returns focus to its planned card");

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
  await mobile.addInitScript(() => {
    const report = { taps: [] as boolean[], moves: [] as boolean[] };
    Object.assign(window, { issue42TouchReport: report });
    document.addEventListener("touchstart", (event) => report.taps.push(event.isTrusted), true);
    document.addEventListener("touchmove", (event) => report.moves.push(event.isTrusted), true);
  });
  await login(mobile);
  await mobile.emulateMedia({ colorScheme: "light" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const mobilePlanned = mobile.locator(".meal-chip").filter({ hasText: plannedName });
  await mobilePlanned.waitFor();
  assert.equal(await mobilePlanned.getAttribute("draggable"), "false", "touch card stays scrollable");
  await mobile.screenshot({ path: join(screenshots, "mobile-light.png"), fullPage: true });
  await mobilePlanned.tap();
  const trustedTaps = await mobile.evaluate(() => (window as unknown as { issue42TouchReport: { taps: boolean[] } }).issue42TouchReport.taps);
  assert.ok(trustedTaps.length > 0 && trustedTaps.every(Boolean), "mobile tap uses trusted browser touch input");
  const mobileDialog = mobile.getByRole("dialog", { name: `Move ${plannedName}` });
  await mobileDialog.waitFor();
  await mobile.screenshot({ path: join(screenshots, "mobile-light-actions.png"), fullPage: true });
  await mobile.getByRole("button", { name: "Cancel", exact: true }).click();
  await mobileDialog.waitFor({ state: "hidden" });

  const scrollBox = await mobilePlanned.boundingBox();
  assert.ok(scrollBox);
  const cdp = await mobile.context().newCDPSession(mobile);
  const beforeScroll = await mobile.evaluate(() => window.scrollY);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: scrollBox.x + scrollBox.width / 2, y: scrollBox.y + scrollBox.height / 2, id: 1 }] });
  for (let step = 1; step <= 5; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: scrollBox.x + scrollBox.width / 2, y: scrollBox.y + scrollBox.height / 2 - step * 22, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobile.waitForTimeout(100);
  assert.equal(await mobile.locator("dialog[open]").count(), 0, "scrolling a touch card does not open the dialog");
  assert.ok((await mobile.evaluate(() => window.scrollY)) > beforeScroll, "touch scroll remains available on a planned card");
  const trustedMoves = await mobile.evaluate(() => (window as unknown as { issue42TouchReport: { moves: boolean[] } }).issue42TouchReport.moves);
  assert.ok(trustedMoves.length > 0 && trustedMoves.every(Boolean), "mobile scroll uses trusted browser touch movement");

  // A hold followed by movement starts a touch drag. Use a tall phone viewport
  // so the calendar and its trash target are both reachable without page auto-scroll.
  const libraryButtons = mobile.locator(".library-chip");
  let touchMealIndex = 0;
  let touchMealName = (await libraryButtons.nth(touchMealIndex).innerText()).replace("⠿", "").trim();
  if (touchMealName === plannedName) {
    touchMealIndex++;
    touchMealName = (await libraryButtons.nth(touchMealIndex).innerText()).replace("⠿", "").trim();
  }
  await libraryButtons.nth(touchMealIndex).click();
  const touchPlanDialog = mobile.getByRole("dialog", { name: `Plan ${touchMealName}` });
  await touchPlanDialog.waitFor();
  await mobile.getByRole("button", { name: "Plan meal", exact: true }).click();
  await mobile.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  await mobile.setViewportSize({ width: 390, height: 1500 });
  const touchPlanned = mobile.locator(".meal-chip").filter({ hasText: touchMealName });
  await touchPlanned.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await mobile.emulateMedia({ colorScheme: "dark" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await mobile.screenshot({ path: join(screenshots, "mobile-dark.png"), fullPage: true });
  await mobile.emulateMedia({ colorScheme: "light" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const sourceCell = touchPlanned.locator("xpath=ancestor::td[contains(@class,'meal-cell')]");
  const sourceDate = await sourceCell.getAttribute("data-date");
  const sourceSlot = await sourceCell.getAttribute("data-slot-id");
  // Select a distinct slot in the same date column; Playwright's native drag is
  // intentionally not involved in this touch path.
  const moveCell = mobile.locator(`.meal-cell[data-date="${sourceDate}"]:not([data-slot-id="${sourceSlot}"])`).first();
  const moveBox = await touchPlanned.boundingBox();
  const cellBox = await moveCell.boundingBox();
  assert.ok(moveBox && cellBox && sourceDate && sourceSlot);
  const cardId = await touchPlanned.getAttribute("data-card-id");
  assert.ok(cardId);
  const mobileChanges: { kind?: string; requestId: string; taskId?: string; date?: string; slotId?: string }[] = [];
  await mobile.route("**/api/change", async (route) => {
    mobileChanges.push(route.request().postDataJSON() as (typeof mobileChanges)[number]);
    await route.continue();
  });
  const cdpTouch = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 2 }] });
    await mobile.waitForTimeout(600);
    assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), true, `long press activates from ${JSON.stringify(from)}; card=${await mobile.locator(".meal-chip").filter({ hasText: touchMealName }).getAttribute("class")}`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...to, id: 2 }] });
    await mobile.waitForTimeout(50);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const moveResponse = mobile.waitForResponse((response) => response.url().endsWith("/api/change") && response.request().method() === "POST", { timeout: 10000 })
    .then((response) => ({ response }), (error: Error) => ({ error }));
  await cdpTouch(
    { x: moveBox.x + moveBox.width / 2, y: moveBox.y + moveBox.height / 2 },
    { x: cellBox.x + cellBox.width / 2, y: cellBox.y + cellBox.height / 2 },
  );
  const moveResult = await moveResponse;
  if ("error" in moveResult) throw moveResult.error;
  await mobile.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  assert.equal(mobileChanges.length, 1, "touch drag sends one move mutation");
  assert.equal(mobileChanges[0]?.kind, "move");
  assert.equal(mobileChanges[0]?.taskId, cardId);
  assert.equal(mobileChanges[0]?.date, sourceDate);
  assert.ok(mobileChanges[0]?.slotId && mobileChanges[0]?.slotId !== sourceSlot);
  assert.ok(mobileChanges[0]?.requestId, "touch move has a stable request ID");
  assert.equal(await mobile.locator("dialog[open]").count(), 0, "completed touch drag does not open the tap dialog");
  const currentBox = await mobile.locator(".meal-chip").filter({ hasText: touchMealName }).boundingBox();
  assert.ok(currentBox);
  const noUnexpectedChange = mobileChanges.length;

  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2, id: 6 }] });
  await mobile.waitForTimeout(150);
  await mobile.evaluate(() => window.dispatchEvent(new Event("blur")));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await mobile.waitForTimeout(500);
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "blur cancels a pending long-press timer");
  assert.equal(await mobile.locator("dialog[open]").count(), 0, "canceled pending hold opens no dialog");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2, id: 11 }] });
  await mobile.waitForTimeout(150);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await mobile.waitForTimeout(500);
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "touchcancel clears a pending long-press timer");

  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2, id: 10 }] });
  await mobile.waitForTimeout(150);
  await mobile.locator(".meal-chip").filter({ hasText: touchMealName }).evaluate((node) => node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() })));
  await mobile.waitForTimeout(500);
  assert.equal(await mobile.locator(".meal-chip").filter({ hasText: touchMealName }).evaluate((node) => node.classList.contains("is-touch-dragging")), false, "native dragstart clears the pending touch timer and source style");
  await mobile.locator(".meal-chip").filter({ hasText: touchMealName }).evaluate((node) => node.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: new DataTransfer() })));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "native dragend clears shared drag state");

  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2, id: 7 }] });
  await mobile.waitForTimeout(600);
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), true);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 12, y: 12, id: 7 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal(mobileChanges.length, noUnexpectedChange, "releasing the initiating finger outside causes no mutation");
  assert.equal(await mobile.locator("dialog[open]").count(), 0, "outside release never opens a dialog");
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false);

  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2, id: 8 }] });
  await mobile.waitForTimeout(600);
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), true);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2, id: 8 },
    { x: 12, y: 12, id: 9 },
  ] });
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "a second finger immediately cancels the gesture");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2, id: 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  assert.equal(mobileChanges.length, noUnexpectedChange, "ending a noninitiating finger cannot commit a mutation");
  assert.equal(await mobile.locator("dialog[open]").count(), 0, "multi-touch cancellation never opens a dialog");
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("trash-hover")), false);

  await cdpTouch(
    { x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2 },
    { x: 12, y: 12 },
  );
  assert.equal(mobileChanges.length, noUnexpectedChange, "outside touch drop is canceled");
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "outside drop clears touch drag state");
  const beginHeldTouch = async () => {
    const box = await mobile.locator(".meal-chip").filter({ hasText: touchMealName }).boundingBox();
    assert.ok(box);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 3 }] });
    await mobile.waitForTimeout(600);
    assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), true);
  };
  const trashBox = await mobile.locator(".trash-drop-target").boundingBox();
  assert.ok(trashBox);
  await beginHeldTouch();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: trashBox.x + trashBox.width / 2, y: trashBox.y + trashBox.height / 2, id: 3 }] });
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("trash-hover")), true);
  await mobile.keyboard.press("Escape");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "Escape cancels the touch drag");
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("trash-hover")), false, "Escape clears trash hover");
  assert.equal(await mobile.locator(".meal-cell.touch-drop-hover").count(), 0, "Escape clears cell hover");
  await beginHeldTouch();
  await mobile.evaluate(() => window.dispatchEvent(new Event("blur")));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "window blur cancels the touch drag");
  await beginHeldTouch();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false, "touchcancel clears the active gesture");
  assert.equal(await mobile.locator("dialog[open]").count(), 0, "canceled hold never opens the tap dialog");
  await mobile.waitForTimeout(50);
  const movedCard = mobile.locator(".meal-chip").filter({ hasText: touchMealName });
  const movedBox = await movedCard.boundingBox();
  assert.ok(trashBox && movedBox);
  let failedDeleteId = "";
  await mobile.unroute("**/api/change");
  await mobile.route("**/api/change", async (route) => {
    const body = route.request().postDataJSON() as (typeof mobileChanges)[number];
    mobileChanges.push(body);
    if (body.kind === "delete" && !failedDeleteId) {
      failedDeleteId = body.requestId;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic provider failure" }) });
    } else await route.continue();
  });
  await cdpTouch(
    { x: movedBox.x + movedBox.width / 2, y: movedBox.y + movedBox.height / 2 },
    { x: trashBox.x + trashBox.width / 2, y: trashBox.y + trashBox.height / 2 },
  );
  await mobile.getByRole("dialog", { name: "Confirm meal deletion" }).waitFor();
  await mobile.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await movedCard.count(), 1, "canceling touch delete keeps the card");
  await mobile.screenshot({ path: join(screenshots, "mobile-light-trash-cancel.png"), fullPage: true });
  const movedBoxAgain = await movedCard.boundingBox();
  assert.ok(movedBoxAgain);
  await cdpTouch(
    { x: movedBoxAgain.x + movedBoxAgain.width / 2, y: movedBoxAgain.y + movedBoxAgain.height / 2 },
    { x: trashBox.x + trashBox.width / 2, y: trashBox.y + trashBox.height / 2 },
  );
  await mobile.getByRole("button", { name: "Delete meal", exact: true }).click();
  await mobile.getByRole("button", { name: /^Retry meal:/ }).waitFor();
  const retryState = JSON.parse((await mobile.evaluate(() => sessionStorage.getItem("planner-pending-http"))) ?? "[]") as { card: { requestId: string }; intent: { kind: string; taskId: string } }[];
  assert.equal(failedDeleteId, mobileChanges.at(-1)?.requestId, "failed touch deletion retains its request ID");
  assert.equal(retryState.at(-1)?.card.requestId, failedDeleteId);
  assert.equal(retryState.at(-1)?.intent.kind, "delete");
  assert.equal(retryState.at(-1)?.intent.taskId, mobileChanges[0]?.taskId);
  await mobile.unroute("**/api/change");
  await mobile.route("**/api/change", async (route) => {
    const body = route.request().postDataJSON() as (typeof mobileChanges)[number];
    mobileChanges.push(body);
    await route.continue();
  });
  await mobile.getByRole("button", { name: /^Retry meal:/ }).click();
  await movedCard.waitFor({ state: "detached" });
  assert.equal(mobileChanges.at(-1)?.requestId, failedDeleteId, "retry reuses the deletion request ID");
  assert.equal(mobileChanges.at(-1)?.kind, "delete");
  await mobile.unroute("**/api/change");
  assert.equal(await mobile.locator("body").evaluate((node) => node.classList.contains("planner-dragging")), false);
  assert.equal(await mobile.locator(".meal-cell.touch-drop-hover").count(), 0);
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

  console.log(`Issue 66 production browser checks passed; screenshots saved in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}

async function assertFocusOn(page: Page, trigger: ReturnType<Page["locator"]>, description: string) {
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, description);
}
