import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-74-"));
const screenshots = resolve(process.env.ISSUE74_SCREENSHOT_DIR ?? ".local/issue-74/after");
const password = `synthetic-${crypto.randomUUID()}`;
const port = "14982";
const origin = `http://127.0.0.1:${port}`;
const currentWeek = "2026-12-28";
const otherWeek = "2027-01-11";
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

async function openPicker(page: Page) {
  await page.getByRole("button", { name: /choose week$/ }).click();
  await page.getByRole("dialog", { name: "Choose a week" }).waitFor();
}

type Geometry = {
  starExists: boolean;
  dy: number;
  starRight: number;
  buttonLeft: number;
  overlapsMonthLabel: boolean;
  border: string;
  borderColor: string;
  background: string;
  pink: string;
  ink: string;
  pressed: string;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(({ currentWeek }) => {
    const button = document.querySelector<HTMLButtonElement>(`.week-picker-week[data-week="${currentWeek}"]`);
    const star = document.querySelector<HTMLElement>(".week-picker-current-star");
    const months = button?.closest(".week-picker-row")?.querySelector<HTMLElement>(".week-picker-months");
    if (!button || !star || !months) return { starExists: false, dy: NaN, starRight: NaN, buttonLeft: NaN, overlapsMonthLabel: true, border: "", borderColor: "", background: "", pink: "", ink: "", pressed: "" };
    const starRect = star.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const walker = document.createTreeWalker(months, NodeFilter.SHOW_TEXT);
    const labelRects: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) labelRects.push(rect);
    }
    const overlapsMonthLabel = labelRects.some(rect =>
      starRect.left < rect.right && starRect.right > rect.left && starRect.top < rect.bottom && starRect.bottom > rect.top);
    const styles = getComputedStyle(button);
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    const pink = getComputedStyle(document.documentElement).getPropertyValue("--pink").trim();
    return {
      starExists: true,
      dy: Math.abs((starRect.top + starRect.height / 2) - (buttonRect.top + buttonRect.height / 2)),
      starRight: starRect.right,
      buttonLeft: buttonRect.left,
      overlapsMonthLabel,
      border: `${styles.borderTopWidth} ${styles.borderTopStyle} ${styles.borderTopColor}`,
      borderColor: styles.borderTopColor,
      background: styles.backgroundColor,
      pink,
      ink,
      pressed: button.getAttribute("aria-pressed") ?? "",
    };
  }, { currentWeek });
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const n = Number.parseInt(full, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

try {
  await mkdir(screenshots, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });

  for (const width of [375, 390, 1440]) {
    const mobile = width < 700;
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 844 : 900 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: theme,
      });
      await context.clock.setFixedTime(new Date("2027-01-01T06:00:00Z"));
      const page = await context.newPage();
      await login(page);
      const toggle = page.getByRole("button", { name: `Switch to ${theme} theme`, exact: true });
      if (await toggle.count()) await toggle.click();
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
      const tag = `${width}-${theme}`;

      await openPicker(page);
      let geometry = await measure(page);
      assert.ok(geometry.starExists, `${tag}: current week star rendered`);
      assert.ok(geometry.dy <= 1, `${tag}: star centered on current button (dy=${geometry.dy})`);
      assert.ok(geometry.starRight < geometry.buttonLeft, `${tag}: star sits strictly left of the button (${geometry.starRight} < ${geometry.buttonLeft})`);
      assert.ok(!geometry.overlapsMonthLabel, `${tag}: star does not overlap month/year labels`);
      assert.match(geometry.border, /^1px solid /, `${tag}: current week has a visible border`);
      assert.equal(geometry.pressed, "true", `${tag}: on open, current week is the selected week`);
      assert.equal(geometry.background, hexToRgb(geometry.pink), `${tag}: selected state keeps the pink fill`);
      const inkRgb = hexToRgb(geometry.ink);
      assert.ok(geometry.borderColor.endsWith(inkRgb), `${tag}: current border uses the ink accent (${geometry.borderColor})`);
      await page.screenshot({ path: join(screenshots, `${tag}-current-selected.png`), fullPage: false });

      await page.locator(`.week-picker-week[data-week="${otherWeek}"]`).click();
      await page.getByRole("dialog", { name: "Choose a week" }).waitFor({ state: "hidden" });
      await openPicker(page);
      geometry = await measure(page);
      assert.ok(geometry.dy <= 1, `${tag}: star stays centered when another week is selected (dy=${geometry.dy})`);
      assert.ok(geometry.starRight < geometry.buttonLeft, `${tag}: star still left of the bordered button`);
      assert.ok(!geometry.overlapsMonthLabel, `${tag}: star clear of month labels at the year boundary`);
      assert.equal(geometry.pressed, "false", `${tag}: current week is no longer the selected week`);
      assert.notEqual(geometry.background, hexToRgb(geometry.pink), `${tag}: current week border stays independent of the pink selected fill`);
      const selected = await page.locator(`.week-picker-week[data-week="${otherWeek}"]`).evaluate((el) => ({
        background: getComputedStyle(el).backgroundColor,
        pressed: el.getAttribute("aria-pressed"),
        current: el.getAttribute("data-current-week"),
      }));
      assert.equal(selected.pressed, "true", `${tag}: other week carries selection`);
      assert.equal(selected.background, hexToRgb(geometry.pink), `${tag}: selected-only week keeps the pink fill`);
      assert.equal(selected.current, null, `${tag}: selected-only week is not marked current`);
      await page.screenshot({ path: join(screenshots, `${tag}-current-vs-selected.png`), fullPage: false });

      const trigger = page.getByRole("button", { name: /choose week$/ });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "Choose a week" }).waitFor({ state: "hidden" });
      assert.ok(await trigger.evaluate((el) => el === document.activeElement), `${tag}: escape returns focus to the week trigger`);
      await openPicker(page);
      const focusedIsRow = await page.evaluate(() => document.activeElement?.classList.contains("week-picker-week"));
      assert.ok(focusedIsRow, `${tag}: opening focuses a week row for keyboard use`);

      await context.close();
    }
  }
  console.log(`Issue 74 checks passed for 375/390/1440 light+dark at 2027-01-01; screenshots in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
