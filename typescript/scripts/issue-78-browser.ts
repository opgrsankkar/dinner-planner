// After npm run build: node --import tsx scripts/issue-78-browser.ts
// Synthetic DB + fake Todoist only; never touches live Todoist or user data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const screenshots = resolve(process.env.ISSUE78_SCREENSHOT_DIR ?? ".local/issue-78");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-78-"));
const password = `synthetic-${crypto.randomUUID()}`;
const port = "3118";
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  cwd: root,
  env: {
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
  },
  stdio: "ignore",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited with ${server.exitCode}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Server did not become ready");
}

async function login(page: Page) {
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).waitFor();
}

async function openLibrary(page: Page) {
  const settingsLink = page.getByRole("link", { name: "Settings", exact: true });
  if (await settingsLink.count() > 0) await settingsLink.click();
  await page.getByRole("button", { name: "Meal library", exact: true }).click();
  const library = page.getByRole("region", { name: "Meal library", exact: true });
  await library.locator(".folio-library-row").first().waitFor();
  return library;
}

async function desktopChecks(theme: "light" | "dark") {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await login(page);
    const library = await openLibrary(page);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const rows = library.locator(".folio-library-row");
    const first = rows.first();
    const surface = first.locator(".folio-library-surface");

    // No touch hint, no sliding surface on a mouse desktop.
    assert.equal(await surface.evaluate((el) => el.getAnimations().length), 0, "desktop shows no swipe hint");
    assert.equal(await surface.evaluate((el) => getComputedStyle(el).transform), "none", "desktop surface does not slide");
    assert.equal(await surface.evaluate((el) => getComputedStyle(el).pointerEvents), "auto", "desktop surface stays interactive");

    const name = (await first.locator(".folio-library-name").innerText()).trim();
    const mealId = (await first.getAttribute("data-meal-id"))!;
    const edit = first.getByRole("button", { name: `Edit ${name}`, exact: true });
    const remove = first.getByRole("button", { name: `Remove ${name} from library`, exact: true });
    await expect(edit).toBeVisible();
    await expect(remove).toBeVisible();
    const editBox = (await edit.boundingBox())!;
    const nameBox = (await first.locator(".folio-library-name").boundingBox())!;
    assert.ok(editBox.x > nameBox.x && editBox.width <= 44, "compact edit icon sits right of the name");
    assert.equal(await edit.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "edit background blends into the row");
    await expect(first).toHaveAttribute("aria-label", /Use the edit or remove buttons\./);

    // Hover highlight is quiet, not a large colourful block.
    await edit.hover();
    const hovered = await edit.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(hovered, "rgba(0, 0, 0, 0)", "hover highlights the action");
    assert.ok(!/40,\s*103,\s*174|180,\s*35,\s*53/.test(hovered), "hover is a quiet tint, not the old solid colour block");
    await page.mouse.move(0, 0);

    // Keyboard: focus the visible edit action and open the editor with Enter.
    await edit.focus();
    await page.keyboard.press("Enter");
    const draft = first.getByRole("textbox");
    await expect(draft).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(draft).toHaveCount(0);

    // Rename persists across a reload.
    const renamed = `Desktop ${theme} renamed ${Date.now()}`;
    await edit.click();
    await first.getByRole("textbox").fill(renamed);
    await first.getByRole("button", { name: "Save", exact: true }).click();
    await expect(first.locator(".folio-library-name")).toHaveText(renamed);
    await page.screenshot({ path: join(screenshots, `desktop-${theme}-library.png`), fullPage: true });
    await page.reload();
    const libraryAfter = await openLibrary(page);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await expect(libraryAfter.locator(`[data-meal-id="${mealId}"] .folio-library-name`)).toHaveText(renamed);

    // Delete: cancel keeps the row, confirm removes it and it stays gone.
    const updated = libraryAfter.locator(`[data-meal-id="${mealId}"]`);
    page.once("dialog", (dialog) => dialog.dismiss());
    await updated.getByRole("button", { name: `Remove ${renamed} from library`, exact: true }).click();
    await expect(updated).toHaveCount(1);
    page.once("dialog", (dialog) => {
      assert.match(dialog.message(), /Planned meals will stay unchanged/);
      void dialog.accept();
    });
    await updated.getByRole("button", { name: `Remove ${renamed} from library`, exact: true }).click();
    await expect(updated).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, `desktop-${theme}-after-delete.png`), fullPage: true });
    await page.reload();
    const finalLibrary = await openLibrary(page);
    await expect(finalLibrary.locator(`[data-meal-id="${mealId}"]`)).toHaveCount(0);

    assert.deepEqual(errors, []);
    console.log(`PASS desktop/${theme}: compact blended actions, no swipe hint/slide, hover/focus highlight, keyboard edit, rename+reload, delete cancel/confirm+reload`);
  } finally {
    await context.close();
  }
}

async function mobileTouchCheck() {
  const context = await browser!.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await login(page);
    const library = await openLibrary(page);
    const first = library.locator(".folio-library-row").first();
    const surface = first.locator(".folio-library-surface");
    // Touch-first devices keep the swipe hint animation.
    await expect.poll(() => surface.evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
    const name = (await first.locator(".folio-library-name").innerText()).trim();
    const cdp = await context.newCDPSession(page);
    async function swipe(dx: number) {
      await first.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      const box = (await first.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 5; step++)
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 5, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await swipe(-80);
    await expect(first).toHaveAttribute("data-reveal", "delete");
    await expect.poll(() => surface.evaluate((el) => getComputedStyle(el).transform)).toBe("matrix(1, 0, 0, 1, -48, 0)");
    await page.screenshot({ path: join(screenshots, "mobile-touch-swipe-delete.png") });
    await swipe(80);
    await expect(first).toHaveAttribute("data-reveal", "edit");
    await expect.poll(() => surface.evaluate((el) => getComputedStyle(el).transform)).toBe("matrix(1, 0, 0, 1, 48, 0)");
    await page.screenshot({ path: join(screenshots, "mobile-touch-swipe-edit.png") });
    await first.getByRole("button", { name: `Edit ${name}`, exact: true }).tap();
    await expect(first.getByRole("textbox")).toBeVisible();
    await first.getByRole("textbox").press("Escape");
    await expect(first.getByRole("textbox")).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log("PASS mobile/touch: swipe hint preserved, CDP swipe left/right reveals delete/edit, tap opens editor");
  } finally {
    await context.close();
  }
}

async function hybridCapabilityCheck() {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, colorScheme: "light" });
  const page = await context.newPage();
  try {
    await login(page);
    const library = await openLibrary(page);
    const first = library.locator(".folio-library-row").first();
    const capability = await page.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      fine: matchMedia("(hover: hover) and (pointer: fine)").matches,
    }));
    assert.ok(capability.coarse || capability.fine, "a hybrid desktop exposes a usable pointer capability");
    if (capability.fine) {
      await expect(first.getByRole("button", { name: /^Edit / })).toBeVisible();
      assert.equal(await first.locator(".folio-library-surface").evaluate((el) => getComputedStyle(el).transform), "none");
    } else {
      await expect.poll(() => first.locator(".folio-library-surface").evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
    }
    console.log(`PASS hybrid/desktop+touch: capability=${capability.coarse ? "coarse" : "fine"} keeps a working edit affordance`);
  } finally {
    await context.close();
  }
}

try {
  await mkdir(screenshots, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  await desktopChecks("light");
  await desktopChecks("dark");
  await mobileTouchCheck();
  await hybridCapabilityCheck();
  console.log(`Issue 78 desktop library checks passed; screenshots in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
