import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const directory = await mkdtemp(join(tmpdir(), "navigation-issues-"));
const screenshots = resolve("../scratch/navigation");
await mkdir(screenshots, { recursive: true });
const password = randomUUID();
const origin = "http://127.0.0.1:3107";
const env = { ...process.env, TODOIST_MODE: "fake", TODOIST_TOKEN: "", TODOIST_TOKEN_FILE: "",
  ALLOWED_HOSTS: "127.0.0.1,localhost", COOKIE_SECURE: "false", DATABASE_PATH: join(directory, "planner.sqlite"),
  PLANNER_DB: join(directory, "planner.sqlite"), FAKE_TODOIST_DB: join(directory, "provider.sqlite"),
  APP_PASSWORD: password, PORT: "3107", HOST: "127.0.0.1", PLANNER_ORIGIN: origin };
const server = spawn(process.execPath, ["scripts/serve.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", chunk => { output += chunk; });
server.stderr.on("data", chunk => { output += chunk; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(origin + "/healthz")).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, output);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  for (const width of [375, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const header = page.locator("header.topbar");
    await page.getByRole("navigation", { name: "Week navigation" }).waitFor();
    assert.equal(await header.getByRole("button", { name: "Log out", exact: true }).count(), 0, "Main header must not contain logout");
    assert.equal(await header.locator(".brand").isVisible(), width > 700, "Brand is desktop only");
    const actions = header.locator(".top-actions");
    assert.deepEqual(await actions.locator("button,a").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? node.textContent?.trim())), ["This week", "Switch to dark theme", "Settings"]);
    const themeBox = await actions.locator(".theme-toggle").boundingBox();
    const settingsBox = await actions.getByRole("link", { name: "Settings", exact: true }).boundingBox();
    assert.ok(themeBox && settingsBox && themeBox.x < settingsBox.x && Math.abs(themeBox.y - settingsBox.y) < 2);
    const toggle = actions.locator(".theme-toggle");
    await toggle.click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.screenshot({ path: join(screenshots, `main-dark-${width}.png`), fullPage: true });
    await toggle.click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.screenshot({ path: join(screenshots, `main-${width}.png`), fullPage: true });
    await actions.getByRole("link", { name: "Settings", exact: true }).click();
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await nav.waitFor();
    assert.deepEqual(await header.locator("a,button").allTextContents(), ["← Back to plan"]);
    await page.screenshot({ path: join(screenshots, `settings-${width}.png`), fullPage: true });
    for (const name of ["Appearance", "Meal library", "Meal slots", "Account"]) {
      await nav.getByRole("button", { name, exact: true }).click();
      assert.equal(await page.locator(".settings-panels > div[id]:visible").count(), 1);
      assert.equal(await header.isVisible(), width > 700, "Mobile subsections hide the app header");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Settings must fit viewport");
      if (width <= 700) {
        assert.equal(await page.getByRole("button", { name: "← Back to settings", exact: true }).isVisible(), true);
        assert.equal(await nav.isVisible(), false);
      }
      if (name === "Meal slots") {
        await page.getByLabel("Slot label 1", { exact: true }).fill("Navigation draft");
        await page.getByRole("button", { name: "Revert", exact: true }).click();
        assert.equal(await page.getByLabel("Slot label 1", { exact: true }).inputValue(), "Breakfast");
      }
      if (name === "Account") {
        assert.equal(await page.locator("#settings-panel-account button").count(), 1);
        assert.equal(await page.getByRole("button", { name: "Log out", exact: true }).isVisible(), true);
      }
      await page.screenshot({ path: join(screenshots, `${name.toLowerCase().replaceAll(" ", "-")}-${width}.png`), fullPage: true });
      if (width <= 700) {
        await page.getByRole("button", { name: "← Back to settings", exact: true }).click();
        assert.equal(await header.isVisible(), true);
        assert.equal(await nav.getByRole("button", { name, exact: true }).evaluate(node => node === document.activeElement), true);
      }
    }
    // The existing authenticated mutation path must still reject missing/invalid CSRF.
    for (const token of [undefined, "invalid"]) {
      const status = await page.evaluate(async token => (await fetch("/api/logout", {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}) }, body: "{}",
      })).status, token);
      assert.equal(status, 403);
    }
    assert.equal((await context.request.get(origin + "/api/board")).status(), 200);
    if (width <= 700) await nav.getByRole("button", { name: "Account", exact: true }).click();
    await page.route("**/api/logout", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic logout failure" }) }));
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Synthetic logout failure" }).waitFor();
    assert.equal((await context.request.get(origin + "/api/board")).status(), 200);
    await page.unroute("**/api/logout");
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal((await context.request.get(origin + "/api/board")).status(), 401);
    assert.equal((await context.request.post(origin + "/api/logout", { data: {}, headers: { Origin: origin } })).status(), 401);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Navigation/security checks passed at ${width}px`);
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  await rm(directory, { recursive: true, force: true });
}
