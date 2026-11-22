// Runs against a production build and a disposable synthetic database only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const directory = await mkdtemp(join(tmpdir(), "planner-servings-"));
const origin = "http://127.0.0.1:3196";
const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  env: { ...process.env, DATABASE_PATH: join(directory, "planner.sqlite"), PLANNER_ORIGIN: origin, HOST: "127.0.0.1", PORT: "3196", ALLOWED_HOSTS: "127.0.0.1" },
  stdio: "inherit",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function request(path: string, body?: unknown) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin + "/healthz")).ok) break; } catch {}
    if (attempt > 100) throw new Error("Server did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const recipe = {
    servings: "4", totalMinutes: 30, notes: "Keeps 3 days.", sourceUrl: "",
    ingredients: [{ amount: "1½ cups", item: "அரிசி (rice), soak 2 hours" }, { amount: "4", item: "eggs" }, { amount: "to taste", item: "salt" }, { amount: "2–4 tsp", item: "oil" }],
    steps: [{ text: "Cook for 5 minutes with 2 cups water.", timerMinutes: 5 }], prep: [{ text: "Soak for 2 hours", hoursBefore: 2 }],
  };
  const { meal } = await request("/api/recipes", { name: "Servings test dosa", recipe });
  await request(`/api/recipes/${meal.id}/variants`, { label: "Rolls", existingLabel: "Classic", isDefault: false, recipe: { ...recipe, servings: "3 large rolls" } });
  await request(`/api/recipes/${meal.id}/variants`, { label: "Unknown", isDefault: false, recipe: { ...recipe, servings: "" } });
  const baseline = await request(`/api/recipes/${meal.id}?all=1`);
  browser = await chromium.launch();
  await mkdir(".local/servings", { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, colorScheme: "light", reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/recipes/${meal.id}`);
    const target = page.getByLabel("Target servings");
    await expect(target).toHaveText("2");
    await expect(page.locator(".recipe-checklist strong")).toHaveText(["3/4 cups", "2", "to taste", "1–2 tsp"]);
    await expect(page.locator(".recipe-checklist")).toContainText("soak 2 hours");
    await expect(page.locator(".recipe-facts")).toHaveText("30 min");
    await expect(page.locator(".recipe-notes-text")).toHaveText("Keeps 3 days.");
    await page.getByRole("button", { name: "More servings" }).focus();
    await page.keyboard.press("Enter");
    await expect(target).toHaveText("3");
    await expect(page.locator(".recipe-checklist strong").nth(1)).toHaveText("3");
    await page.locator(".recipe-checklist input").first().check();
    await page.getByRole("tab", { name: "Rolls", exact: true }).click();
    await expect(target).toHaveText("2");
    await expect(page.getByRole("button", { name: "More servings" })).toBeDisabled();
    await expect(page.locator(".recipe-servings-unavailable")).toHaveText("Source yield: 3 large rolls · quantities unchanged");
    await expect(page.locator(".recipe-checklist strong").first()).toHaveText("1½ cups");
    await expect(page.locator(".recipe-checklist input").first()).not.toBeChecked();
    await page.getByRole("tab", { name: "Unknown", exact: true }).click();
    await expect(page.locator(".recipe-servings-unavailable")).toHaveText("Source servings unknown · quantities unchanged");
    await page.getByRole("tab", { name: /Classic/ }).click();
    await expect(target).toHaveText("3");
    await expect(page.locator(".recipe-checklist input").first()).toBeChecked();
    await page.getByRole("button", { name: "Fewer servings" }).click();
    await page.getByRole("button", { name: "Fewer servings" }).click();
    await expect(target).toHaveText("1");
    await expect(page.getByRole("button", { name: "Fewer servings" })).toBeDisabled();
    await page.getByRole("button", { name: "More servings" }).click();
    await page.screenshot({ path: `.local/servings/recipe-${viewport.width}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal overflow");
    await page.getByRole("button", { name: "Cook", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Start 5 min timer" })).toBeVisible();
    await expect(dialog.locator(".cook-step-text")).toHaveText(recipe.steps[0]!.text);
    await dialog.getByRole("button", { name: "Start 5 min timer" }).click();
    await dialog.getByRole("button", { name: "Ingredients", exact: true }).click();
    await expect(dialog.getByLabel("Target servings")).toHaveText("2");
    await expect(dialog.locator(".recipe-checklist strong").first()).toHaveText("3/4 cups");
    await dialog.getByRole("button", { name: "More servings" }).click();
    await expect(dialog.getByLabel("Target servings")).toHaveText("3");
    await expect(dialog.locator(".recipe-checklist strong").nth(1)).toHaveText("3");
    await page.screenshot({ path: `.local/servings/cook-${viewport.width}.png` });
    await dialog.getByRole("button", { name: "Ingredients", exact: true }).click();
    await expect(dialog.locator(".cook-timer-button")).toHaveText(/(?:5:00|4:\d{2}) · Stop/);
    await dialog.getByRole("button", { name: "Leave cook mode" }).click();
    await expect(target).toHaveText("3");
    await page.reload();
    await expect(target).toHaveText("2");
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.deepEqual(await request(`/api/recipes/${meal.id}?all=1`), baseline, "viewer and cook interactions must not write recipes or variants");
  console.log("Servings production browser smoke passed: desktop/mobile, default 2, keyboard, bounds, variants/ticks, unknown yields, cook synchronization, unchanged times/text, reload reset and stored-data integrity.");
} finally {
  await browser?.close();
  if (server.exitCode === null) await new Promise<void>(resolve => { server.once("exit", () => resolve()); server.kill("SIGTERM"); });
  await rm(directory, { recursive: true, force: true });
}
