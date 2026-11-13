// Production-build PWA check: headers, installability, worker scope, offline
// fallback, and that API requests and writes bypass the worker.
// Run `npm run build` first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const directory = await mkdtemp(join(tmpdir(), "planner-pwa-"));
const origin = "http://127.0.0.1:3199";
const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  env: {
    ...process.env, DATABASE_PATH: join(directory, "planner.sqlite"),
    PLANNER_ORIGIN: origin, HOST: "127.0.0.1", PORT: "3199", ALLOWED_HOSTS: "127.0.0.1",
  },
  stdio: "inherit",
});
const browser = await chromium.launch();
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin + "/healthz")).ok) break; } catch {}
    if (attempt > 100) throw new Error("server did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const [path, type] of [
    ["/service-worker.js", "text/javascript"],
    ["/manifest.webmanifest", "application/manifest+json"],
    ["/offline.html", "text/html; charset=utf-8"],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), type, path);
    assert.equal(response.headers.get("cache-control"), "no-cache", path);
  }

  const context = await browser.newContext({ colorScheme: "light" });
  const page = await context.newPage();
  await page.goto(origin + "/");
  await page.locator(".meal-grid").waitFor();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.equal(scope, origin + "/");
  // Both theme-color tags survive SSR and follow an explicit theme override.
  const themeColors = () => page.evaluate(() =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute("content")));
  assert.deepEqual(await themeColors(), ["#edbb97", "#edbb97"]);
  await page.locator(".theme-toggle").click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.deepEqual(await themeColors(), ["#352b32", "#352b32"]);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  assert.deepEqual(installabilityErrors, [], JSON.stringify(installabilityErrors));
  const manifest = await cdp.send("Page.getAppManifest");
  assert.deepEqual(manifest.errors, []);

  // Online after the worker controls the page: the planner still loads and
  // API reads and writes go straight to the network.
  await page.reload();
  assert.ok(await page.evaluate(() => navigator.serviceWorker.controller !== null));
  const worker = [] as string[];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.fromServiceWorker()) worker.push(response.url());
  });
  await page.locator(".meal-grid").waitFor();
  const status = await page.evaluate(async () =>
    (await fetch("/api/settings/theme", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "light" }),
    })).status);
  assert.ok(status >= 200 && status < 300, `write status ${status}`);
  assert.deepEqual(worker, [], "API traffic must bypass the service worker");

  await context.setOffline(true);
  await page.goto(origin + "/settings");
  await page.getByRole("heading", { name: "Can't reach Meal Planner" }).waitFor();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await page.locator(".meal-grid").waitFor();
  console.log("PWA smoke passed");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
