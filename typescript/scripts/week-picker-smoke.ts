import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { addDays, calendarWeeks, weekStart } from "../src/week-calendar";

const artifacts = resolve(".local/comparison");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "week-picker-"));
const password = randomUUID();
const origin = "http://127.0.0.1:3118";
// Explicit fake provider, isolated DB, generated password; no deployment configuration.
const env = { PATH: process.env.PATH, HOME: directory, NODE_ENV: "production", TODOIST_MODE: "fake",
  TODOIST_TOKEN: "", TODOIST_TOKEN_FILE: "", ALLOWED_HOSTS: "127.0.0.1,localhost", COOKIE_SECURE: "false",
  DATABASE_PATH: join(directory, "planner.sqlite"), PLANNER_DB: join(directory, "planner.sqlite"),
  FAKE_TODOIST_DB: join(directory, "provider.sqlite"), APP_PASSWORD: password,
  PORT: "3118", HOST: "127.0.0.1", PLANNER_ORIGIN: origin };
const server = spawn(process.execPath, ["scripts/serve.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", chunk => { output += chunk; });
server.stderr.on("data", chunk => { output += chunk; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(origin + "/healthz")).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, output);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  for (const scenario of [
    { width: 1440, height: 900, date: "2026-10-02", reduced: false },
    { width: 375, height: 667, date: "2026-10-02", reduced: true },
    { width: 390, height: 844, date: "2026-12-31", reduced: true },
  ]) {
    const { width, height, date, reduced } = scenario;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference", hasTouch: width < 700 });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(`${date}T12:00:00Z`));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("navigation", { name: "Week navigation" }).waitFor();
    const thisWeek = page.getByRole("button", { name: "This week", exact: true });
    await expect(thisWeek).toHaveCount(0);
    const trigger = page.getByRole("button", { name: /choose week/ });
    // This behavior assertion fails on master: its week range is an inert span.
    await expect(trigger).toBeVisible({ timeout: 5000 });
    const modal = page.getByRole("dialog", { name: "Choose a week", exact: true });
    const initialWeek = weekStart(date);
    const calendar = calendarWeeks(date);
    for (const theme of ["light", "dark"] as const) {
      const changeTheme = page.getByRole("button", { name: `Switch to ${theme} theme`, exact: true });
      if (await changeTheme.count()) await changeTheme.click();
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(modal).toBeVisible();
      await expect(modal.locator(`[data-week="${initialWeek}"]`)).toBeFocused();
      const selected = modal.locator('[aria-pressed="true"]');
      await expect(selected).toHaveCount(1);
      assert.equal(await selected.getAttribute("data-week"), initialWeek);
      assert.equal(await selected.locator("[data-date]").count(), 7, "Cross-month week highlights all seven days");
      const dates = await modal.locator("[data-date]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-date")));
      assert.equal(dates[0], calendar.first);
      assert.equal(dates.at(-1), calendar.last);
      assert.deepEqual(await modal.locator("[data-month]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-month"))), calendar.rows.flatMap(row => row.months));
      const starts = await modal.locator("[data-week]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-week")!));
      starts.forEach((start, i) => { assert.equal(weekStart(start), start); if (i) assert.equal(start, addDays(starts[i - 1]!, 7)); });
      assert.equal(await modal.locator("[data-month] small").count(), date.startsWith("2026-12") ? 1 : 0);
      if (date.startsWith("2026-12")) await expect(modal.locator('[data-month="2027-01"] small')).toHaveText("2027");
      const colors = await selected.locator("span").evaluateAll(nodes => nodes.map(node => ({ current: node.classList.contains("current-month"), color: getComputedStyle(node).color })));
      const currentColor = colors.find(cell => cell.current)!.color;
      const adjacentColor = colors.find(cell => !cell.current)!.color;
      const brightness = (color: string) => color.match(/\d+/g)!.map(Number).slice(0, 3).reduce((sum, value) => sum + value, 0);
      assert.ok(theme === "light" ? brightness(currentColor) < brightness(adjacentColor) : brightness(currentColor) > brightness(adjacentColor), "Current month has darker light ink / brighter dark ink");
      const cells = await selected.locator("span").evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })));
      cells.forEach((cell, i) => { assert.equal(cell.y, cells[0]!.y); if (i) assert.ok(cell.x > cells[i - 1]!.x); });
      const rect = await modal.boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height, "Dialog fits viewport");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Planner navigation fits viewport");
      const scroll = modal.locator(".week-picker-scroll");
      await scroll.evaluate(node => { node.scrollTop = -99999; });
      assert.equal(await scroll.evaluate(node => node.scrollTop), 0);
      await scroll.evaluate(node => { node.scrollTop = 99999; });
      assert.equal(await scroll.evaluate(node => Math.abs(node.scrollTop - (node.scrollHeight - node.clientHeight)) <= 1), true);
      await selected.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), reduced);
      assert.equal(await modal.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length), 0);
      await page.screenshot({ path: join(artifacts, `week-picker-${width}-${date}-${theme}.png`), fullPage: true });
      // Native modal traps focus: repeated Tab must stay inside it.
      for (let i = 0; i < starts.length + 3; i++) {
        await page.keyboard.press("Tab");
        assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true);
      }
      await modal.getByRole("button", { name: "Close week picker", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(modal.locator("[data-week]").last()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(modal.getByRole("button", { name: "Close week picker", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(modal).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await page.screenshot({ path: join(artifacts, `week-nav-current-${width}-${date}-${theme}.png`), fullPage: true });
    }
    await trigger.press("Space");
    await expect(modal).toBeVisible();
    const nextWeek = addDays(initialWeek, 7);
    const next = modal.locator(`[data-week="${nextWeek}"]`);
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(modal).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.locator(".day-header .day-date").first()).toHaveText(new Date(`${nextWeek}T12:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }));
    await page.getByRole("button", { name: "Previous week", exact: true }).click();
    await trigger.click();
    await expect(modal.locator(`[data-week="${initialWeek}"]`)).toHaveAttribute("aria-pressed", "true");
    const tappedWeek = addDays(initialWeek, -7);
    const tap = modal.locator(`[data-week="${tappedWeek}"]`);
    if (width < 700) await tap.tap(); else await tap.click();
    await expect(modal).not.toBeVisible();
    await expect(thisWeek).toBeVisible();
    await page.screenshot({ path: join(artifacts, `week-nav-past-${width}-${date}.png`), fullPage: true });
    await thisWeek.click();
    await expect(thisWeek).toHaveCount(0);
    assert.equal(await page.locator(".day-header .day-date").first().textContent(), new Date(`${initialWeek}T12:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }));
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await expect(thisWeek).toBeVisible();
    await page.screenshot({ path: join(artifacts, `week-nav-future-${width}-${date}.png`), fullPage: true });
    await thisWeek.click();
    await expect(thisWeek).toHaveCount(0);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("link", { name: "← Back to plan", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "← Back to plan", exact: true }).click();
    await expect(thisWeek).toHaveCount(0);
    // Arrows remain unrestricted; opening an out-of-bounds week must preserve it without a false selection.
    for (let i = 0; i < 22; i++) await page.getByRole("button", { name: "Next week", exact: true }).click();
    const outsideLabel = await trigger.textContent();
    await trigger.click();
    await expect(modal.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(modal.locator(`[data-week="${initialWeek}"]`)).toBeFocused();
    await page.getByRole("button", { name: "Close week picker", exact: true }).click();
    assert.equal(await trigger.textContent(), outsideLabel);
    await expect(trigger).toBeFocused();
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}x${height}, ${date}, light/dark, reducedMotion=${reduced}: calendar bounds/continuity, full cross-month highlight, year, keyboard/touch choice, focus trap/Escape, arrows and outside-range preservation`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  await writeFile(join(artifacts, "browser-server.log"), output);
  await rm(directory, { recursive: true, force: true });
}
