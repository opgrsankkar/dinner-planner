import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-41-"));
const screenshots = process.env.ISSUE41_SCREENSHOT_DIR ?? join(tmpdir(), "dinner-planner-issue-41");
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
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function assertTrashHidden(page: Page, label: string) {
  const state = await page.evaluate(() => ({
    classes: document.body.className,
    opacity: getComputedStyle(document.querySelector(".trash-drop-target")!).opacity,
    icon: document.querySelector(".trash-drop-target use")?.getAttribute("href"),
  }));
  assert.ok(!state.classes.includes("planner-dragging"), `${label}: drag state cleared`);
  assert.equal(state.opacity, "0", `${label}: trash affordance hidden`);
  return state;
}

async function login(page: Page) {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("complementary", { name: "Meal library", exact: true }).waitFor();
}

try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:3100/healthz")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(desktop);

  const libraryMeal = desktop.locator(".library-chip").first();
  const plannedName = (await libraryMeal.innerText()).replace("⠿", "").trim();
  await libraryMeal.click();
  await desktop.getByRole("button", { name: "Plan meal", exact: true }).click();
  let planned = desktop.locator(".meal-chip").filter({ hasText: plannedName });
  await planned.waitFor();
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();

  // Save the visible affordance for comparison; synthetic dragstart is dispatched
  // by the real production component and exercises its native handler.
  await planned.evaluate((node) => node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() })));
  await desktop.waitForTimeout(350);
  assert.equal(await desktop.locator(".trash-drop-target use").getAttribute("href"), "/static/lucide-icons.svg#trash-2");
  await desktop.screenshot({ path: join(screenshots, "after-active-desktop-light.png"), fullPage: true });
  await desktop.keyboard.press("Escape");
  await assertTrashHidden(desktop, "Escape cancellation");

  await planned.evaluate((node) => node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() })));
  await desktop.evaluate(() => window.dispatchEvent(new Event("blur")));
  await assertTrashHidden(desktop, "window blur cancellation");

  await planned.dragTo(desktop.locator(".meal-cell").last(), { force: true });
  await assertTrashHidden(desktop, "successful move drop");
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();

  planned = desktop.locator(".meal-chip").filter({ hasText: plannedName });
  await planned.dragTo(desktop.getByLabel("Delete dragged planned meal", { exact: true }), { force: true });
  await desktop.getByRole("dialog", { name: "Confirm meal deletion" }).waitFor();
  await assertTrashHidden(desktop, "delete drop");
  await desktop.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await planned.count(), 1, "canceling delete preserves the planned card");
  await planned.dragTo(desktop.getByLabel("Delete dragged planned meal", { exact: true }), { force: true });
  await desktop.getByRole("button", { name: "Delete meal", exact: true }).click();
  await planned.waitFor({ state: "detached" });
  await assertTrashHidden(desktop, "confirmed delete");

  // A library drag is a copy gesture and must never expose planned-meal deletion.
  const newName = `Issue 41 meal ${crypto.randomUUID().slice(0, 8)}`;
  await desktop.getByRole("searchbox").fill(newName);
  await desktop.getByRole("button", { name: "Add meal", exact: true }).click();
  const newLibraryMeal = desktop.locator(".library-chip").filter({ hasText: newName });
  await newLibraryMeal.waitFor();
  await newLibraryMeal.dragTo(desktop.locator(".meal-cell").first(), { force: true });
  await desktop.locator(".meal-chip").filter({ hasText: newName }).waitFor();
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  await assertTrashHidden(desktop, "library item drag");

  // Consecutive planned drags and an outside drop all finish with no stale target.
  planned = desktop.locator(".meal-chip").filter({ hasText: newName });
  await planned.dragTo(desktop.locator(".meal-cell").last(), { force: true });
  await desktop.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
  await assertTrashHidden(desktop, "first consecutive drag");
  planned = desktop.locator(".meal-chip").filter({ hasText: newName });
  await planned.dragTo(desktop.locator(".topbar"), { force: true });
  await assertTrashHidden(desktop, "outside drop");

  // A failed move stays pending with its original request identity; drag cleanup
  // must not alter or accidentally retry that mutation.
  const moveRequests: string[] = [];
  await desktop.route("**/api/change", async (route) => {
    const body = route.request().postDataJSON() as { requestId: string };
    moveRequests.push(body.requestId);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic provider failure" }) });
  });
  planned = desktop.locator(".meal-chip").filter({ hasText: newName });
  await planned.dragTo(desktop.locator(".meal-cell").first(), { force: true });
  await desktop.getByRole("button", { name: /^Retry meal:/ }).waitFor();
  const pending = JSON.parse((await desktop.evaluate(() => sessionStorage.getItem("planner-pending-http"))) ?? "[]") as { card: { requestId: string } }[];
  assert.equal(moveRequests.length, 1);
  assert.equal(pending.at(-1)?.card.requestId, moveRequests[0], "failed mutation retains its request ID");
  assert.equal(await planned.getAttribute("draggable"), "false", "pending mutation cannot be dragged again");
  await assertTrashHidden(desktop, "failed pending move");

  await desktop.emulateMedia({ colorScheme: "dark" });
  await desktop.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await desktop.screenshot({ path: join(screenshots, "after-pending-desktop-dark.png"), fullPage: true });

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await login(mobile);
  await mobile.emulateMedia({ colorScheme: "light" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert.equal(await mobile.locator(".trash-drop-target").evaluate((node) => getComputedStyle(node).opacity), "0");
  await mobile.screenshot({ path: join(screenshots, "after-mobile-light.png"), fullPage: true });
  await mobile.emulateMedia({ colorScheme: "dark" });
  await mobile.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await mobile.screenshot({ path: join(screenshots, "after-mobile-dark.png"), fullPage: true });
  // Mobile retains its non-drag planning alternative and keeps the affordance hidden.
  await mobile.getByRole("button", { name: `Plan ${newName}`, exact: true }).waitFor();
  assert.equal(await mobile.locator(".trash-drop-target").evaluate((node) => getComputedStyle(node).opacity), "0");

  console.log(`Issue 41 production browser checks passed; screenshots saved in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve())).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
