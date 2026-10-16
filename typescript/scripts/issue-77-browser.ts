import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const screenshots = resolve(process.env.ISSUE77_SCREENSHOT_DIR ?? ".local/issue-77");
const directory = await mkdtemp(join(tmpdir(), "planner-issue-77-"));
const password = `synthetic-${crypto.randomUUID()}`;
const port = "3117";
const origin = `http://127.0.0.1:${port}`;
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
const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  cwd: root,
  env,
  stdio: "ignore",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const todayIso = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Production server exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Production server did not become ready");
}

async function login(page: Page) {
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("complementary", { name: "Meal library", exact: true })
    .waitFor();
}

async function openPlan(page: Page, name: string) {
  await page
    .locator(".library-chip")
    .filter({ has: page.locator(".library-chip-name", { hasText: name }) })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: `Plan ${name}` });
  await dialog.waitFor();
  return dialog;
}

async function placeViaDialog(
  page: Page,
  name: string,
  date: string,
  slotId: string,
) {
  const dialog = await openPlan(page, name);
  await dialog.locator("#plan-day").selectOption(date);
  await dialog.locator("#plan-slot").selectOption(slotId);
  await dialog.getByRole("button", { name: "Plan meal" }).click();
  await dialog.waitFor({ state: "hidden" });
}

function chipAt(page: Page, date: string, slotId: string) {
  return page.locator(
    `.meal-cell[data-date="${date}"][data-slot-id="${slotId}"] .meal-chip`,
  );
}

async function assertStruck(
  page: Page,
  date: string,
  slotId: string,
  expected: boolean,
) {
  await chipAt(page, date, slotId).first().waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ date, slotId, expected }) => {
      const chip = document.querySelector(
        `.meal-cell[data-date="${date}"][data-slot-id="${slotId}"] .meal-chip`,
      );
      if (!chip) return false;
      const struck =
        chip.classList.contains("is-complete") &&
        getComputedStyle(chip).textDecorationLine.includes("line-through");
      return struck === expected;
    },
    { date, slotId, expected },
    { timeout: 5000 },
  );
}

try {
  await mkdir(screenshots, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const page = await desktop.newPage();
  await login(page);

  const names = await page.locator(".library-chip-name").allTextContents();
  assert.ok(names.length >= 2, "seeded library is available");

  // Read the displayed week and pick one past and one future day.
  const probe = await openPlan(page, names[0]!);
  const days = await probe
    .locator("#plan-day option")
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter(Boolean),
    );
  const slots = await probe
    .locator("#plan-slot option")
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter(Boolean),
    );
  await probe.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(slots.length >= 1, "seeded slots are available");
  const breakfast = slots[0]!;
  const pastDay = [...days].filter((day) => day < todayIso).sort().at(-1);
  const futureDay = [...days].filter((day) => day > todayIso).sort()[0];
  assert.ok(pastDay, "the displayed week contains a past day");
  assert.ok(futureDay, "the displayed week contains a future day");

  // Past meal: stricken immediately, then still stricken after reload.
  await placeViaDialog(page, names[0]!, pastDay!, breakfast);
  await assertStruck(page, pastDay!, breakfast, true);
  await page.screenshot({
    path: join(screenshots, "desktop-past-immediate.png"),
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole("complementary", { name: "Meal library", exact: true })
    .waitFor();
  await assertStruck(page, pastDay!, breakfast, true);
  await page.screenshot({
    path: join(screenshots, "desktop-past-after-reload.png"),
    fullPage: true,
  });

  // Future meal: created but not stricken.
  await placeViaDialog(page, names[1]!, futureDay!, breakfast);
  await assertStruck(page, futureDay!, breakfast, false);
  await page.screenshot({
    path: join(screenshots, "desktop-future-open.png"),
    fullPage: true,
  });
  await desktop.close();

  // Mobile touch: past meal is stricken.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });
  const phone = await mobile.newPage();
  await login(phone);
  await placeViaDialog(phone, names[0]!, pastDay!, breakfast);
  await assertStruck(phone, pastDay!, breakfast, true);
  await chipAt(phone, pastDay!, breakfast)
    .first()
    .scrollIntoViewIfNeeded();
  await phone.screenshot({
    path: join(screenshots, "mobile-past-strikethrough.png"),
    fullPage: true,
  });
  await mobile.close();

  console.log(`Issue 77 completion checks passed; screenshots in ${screenshots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null)
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
