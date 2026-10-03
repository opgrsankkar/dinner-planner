import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-67-"));
const screenshots = resolve(process.env.ISSUE67_SCREENSHOT_DIR ?? ".local/issue-67/after");
const password = `synthetic-${crypto.randomUUID()}`;
const origin = "http://127.0.0.1:3113";
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  TODOIST_MODE: "fake",
  PRISMA_DISABLE_TELEMETRY: "1",
  ALLOWED_HOSTS: "127.0.0.1,localhost",
  COOKIE_SECURE: "false",
  DATABASE_PATH: join(directory, "planner.sqlite"),
  APP_PASSWORD: password,
  PORT: "3113",
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

try {
  await mkdir(screenshots, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const assertStyle = process.env.ISSUE67_ASSERT_STYLE !== "0";

  for (const width of [1440, 390]) {
    const mobile = width === 390;
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 844 : 900 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: theme,
      });
      const page = await context.newPage();
      await login(page);
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);

      await page.getByRole("button", { name: "Next week", exact: true }).click();
      const meal = page.locator(".library-chip").first();
      const name = (await meal.innerText()).replace("⠿", "").trim();
      if (mobile) await meal.tap();
      else await meal.click();
      await page.getByRole("dialog", { name: `Plan ${name}` }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Delete meal", exact: true }).count(), 0);
      await page.getByRole("button", { name: "Plan meal", exact: true }).click();
      await page.getByRole("status", { name: "Meal saved", exact: true }).waitFor();
      const planned = page.getByRole("button", { name: `Move or delete ${name}`, exact: true }).first();
      if (mobile) await planned.tap();
      else await planned.click();

      const dialog = page.getByRole("dialog", { name: `Move ${name}` });
      const remove = dialog.getByRole("button", { name: "Delete meal", exact: true });
      await remove.waitFor();
      await page.screenshot({
        path: join(screenshots, `${mobile ? "mobile" : "desktop"}-${theme}-move-dialog.png`),
        fullPage: true,
      });

      if (assertStyle) {
        let focused = false;
        for (let index = 0; index < 8; index++) {
          await page.keyboard.press("Tab");
          if (await remove.evaluate((button) => button === document.activeElement)) {
            focused = await remove.evaluate((button) => button.matches(":focus-visible") && getComputedStyle(button).outlineStyle !== "none");
            break;
          }
        }
        const appearance = await remove.evaluate((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          const beforeHover = { transform: style.transform, shadow: style.boxShadow };
          button.blur();
          (button as HTMLButtonElement).disabled = true;
          const disabled = getComputedStyle(button).opacity !== "1" && getComputedStyle(button).cursor === "not-allowed";
          (button as HTMLButtonElement).disabled = false;
          return {
            height: rect.height,
            width: rect.width,
            radius: style.borderRadius,
            border: style.borderTopWidth,
            background: style.backgroundColor,
            color: style.color,
            shadow: beforeHover.shadow,
            disabled,
          };
        });
        assert.ok(appearance.height >= 44 && appearance.width >= 44, `${width}px ${theme}: delete action meets 44px target`);
        assert.equal(appearance.border, "1px");
        assert.match(appearance.radius, /5px/);
        assert.match(appearance.shadow, /2px 2px 0px/);
        assert.ok(focused, `${width}px ${theme}: destructive action has visible keyboard focus`);
        assert.ok(appearance.disabled, `${width}px ${theme}: disabled destructive action has a disabled treatment`);
        const primaryBackground = await dialog.getByRole("button", { name: "Move meal", exact: true }).evaluate((button) => getComputedStyle(button).backgroundColor);
        assert.notEqual(appearance.background, primaryBackground, `${width}px ${theme}: destructive treatment differs from primary action`);
        await remove.hover();
        const hover = await remove.evaluate((button) => getComputedStyle(button).transform);
        assert.notEqual(hover, "none", `${width}px ${theme}: delete action has hover feedback`);
      }
      await context.close();
    }
  }
  console.log(`Issue 67 production screenshots saved in ${screenshots}${assertStyle ? "; light/dark desktop/mobile style checks passed" : ""}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
