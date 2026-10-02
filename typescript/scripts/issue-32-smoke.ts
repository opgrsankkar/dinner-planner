import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const directory = await mkdtemp(join(tmpdir(), "issue-32-"));
const screenshots = resolve(".local/issue-32");
await mkdir(screenshots, { recursive: true });
const password = randomUUID();
const origin = "http://127.0.0.1:3112";
const env = {
  ...process.env,
  TODOIST_MODE: "fake", TODOIST_TOKEN: "", TODOIST_TOKEN_FILE: "",
  ALLOWED_HOSTS: "127.0.0.1,localhost", COOKIE_SECURE: "false",
  DATABASE_PATH: join(directory, "planner.sqlite"), PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"), APP_PASSWORD: password,
  PORT: "3112", HOST: "127.0.0.1", PLANNER_ORIGIN: origin,
};
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

  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport: { width, height: width > 700 ? 900 : 844 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("navigation", { name: "Week navigation" }).waitFor();
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.getByRole("button", { name: `Switch to ${theme} theme`, exact: true }).click();
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
      }
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      const nav = page.getByRole("navigation", { name: "Settings sections" });
      await nav.waitFor();
      await nav.getByRole("button", { name: "Account", exact: true }).click();
      const logout = page.getByRole("button", { name: "Log out", exact: true });
      if (width > 700) {
        await page.keyboard.press("Tab");
        await logout.focus();
        assert.equal(await logout.evaluate(button => button.matches(":focus-visible")), true, "Log out must show keyboard focus");
        assert.notEqual(await logout.evaluate(button => getComputedStyle(button).outlineStyle), "none", "Keyboard focus must have a visible outline");
        await logout.evaluate(button => (button as HTMLButtonElement).blur());
      }
      const appearance = await logout.evaluate(button => {
        const style = getComputedStyle(button);
        return { border: style.borderTopWidth, radius: style.borderRadius, shadow: style.boxShadow, background: style.backgroundColor };
      });
      assert.equal(appearance.border, "1px", "Folio ink outline should replace generic secondary border");
      assert.match(appearance.radius, /5px/, "Button should use the Folio hand-drawn corner treatment");
      assert.match(appearance.shadow, /3px 3px 0px/, "Button should use the Folio offset ink shadow");
      assert.notEqual(appearance.background, "rgba(0, 0, 0, 0)");
      await page.screenshot({ path: join(screenshots, `account-${theme}-${width > 700 ? "desktop" : "mobile"}.png`), fullPage: true });

      await page.route("**/api/logout", async route => {
        await new Promise(resolve => setTimeout(resolve, 700));
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic logout failure" }) });
      });
      await logout.click();
      await page.getByRole("button", { name: "Logging out…", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Logging out…", exact: true }).isDisabled(), true);
      if (width === 1440 && theme === "light") await page.screenshot({ path: join(screenshots, "logout-pending-desktop.png"), fullPage: true });
      await page.getByRole("alert").filter({ hasText: "Synthetic logout failure" }).waitFor();
      assert.equal(await logout.isEnabled(), true, "Logout must be retryable after a failed request");
      if (width === 1440 && theme === "light") await page.screenshot({ path: join(screenshots, "logout-error-desktop.png"), fullPage: true });
      await page.unroute("**/api/logout");

      await logout.click();
      await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
      assert.equal((await context.request.get(origin + "/api/board")).status(), 401, "Successful logout must invalidate the session");
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`Issue #32 browser checks passed: ${theme} ${width}px, styled/focused control, pending/error feedback, real logout.`);
    }
  }
  console.log(`Issue #32 production screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  await rm(directory, { recursive: true, force: true });
}
