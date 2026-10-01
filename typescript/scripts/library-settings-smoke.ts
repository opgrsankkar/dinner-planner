import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

// Isolated synthetic component harness: the shell's success contract is explicit.
const root = await mkdtemp(join(tmpdir(), "library-settings-"));
const project = resolve(import.meta.dirname, "..");
await writeFile(join(root, "index.html"), '<div id="root"></div><script type="module" src="/harness.tsx"></script>');
await writeFile(join(root, "harness.tsx"), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MealLibrarySettings } from '/@fs/${project}/src/settings/MealLibrarySettings.tsx';
window.calls = [];
window.outcome = true;
window.release = null;
function Harness() {
  const [feedback, setFeedback] = useState('');
  const [library, setLibrary] = useState([{id: 'pasta', name: 'Vegetable pasta'}]);
  return <>{feedback && <p role="alert">{feedback}</p>}<p data-testid="planned">Planned: Vegetable pasta</p><MealLibrarySettings library={library} action={async (path, body) => {
    setFeedback('');
    window.calls.push({path, body});
    await new Promise(resolve => { window.release = resolve; });
    if (window.outcome === false) setFeedback('Synthetic handled failure');
    if (window.outcome === 'reject') throw new Error('Synthetic failure');
    if (window.outcome === true) {
      if (path === '/api/library') setLibrary(current => [...current, {id: body.name, name: body.name}]);
      else setLibrary(current => current.filter(meal => meal.id !== body.mealId));
    }
    return window.outcome;
  }} /></>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`);
const server = await createServer({ configFile: false, root,
  resolve: { alias: { "react-dom": join(project, "node_modules/react-dom"), react: join(project, "node_modules/react") } },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root, project] } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]!);
  const input = page.getByLabel("Add a meal", { exact: true });
  const submit = page.getByRole("button", { name: "Add meal", exact: true });
  const calls = () => page.evaluate(() => (window as any).calls);
  const release = () => page.evaluate(() => (window as any).release());
  await input.fill("   ");
  assert.equal(await submit.isDisabled(), true);
  await input.press("Enter");
  assert.equal((await calls()).length, 0);
  await input.fill("  Lentil soup  ");
  await input.press("Enter");
  await page.getByRole("button", { name: "Adding…" }).waitFor();
  assert.equal(await input.isDisabled(), true);
  await page.locator("form").evaluate(form => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(await calls(), [{path: "/api/library", body: {name: "Lentil soup"}}]);
  await release();
  await page.getByRole("status").filter({ hasText: "Added Lentil soup" }).waitFor();
  assert.equal(await input.inputValue(), "");
  for (const outcome of [false, undefined, "reject"]) {
    await page.evaluate(value => { (window as any).outcome = value; }, outcome);
    await input.fill("Keep draft");
    await submit.click();
    await page.getByRole("button", { name: "Adding…" }).waitFor();
    await release();
    await expect(submit).toBeEnabled();
    await expect(input).toHaveValue("Keep draft");
    await expect(page.getByRole("status")).toHaveCount(0);
    if (outcome === false) {
      await expect(page.getByRole("alert")).toHaveText("Synthetic handled failure");
    } else if (outcome === "reject") {
      await expect(page.getByRole("alert")).toHaveText("Synthetic failure");
    } else {
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator(".meal-library-add-feedback")).toHaveText("");
    }
    await expect(page.locator(".manage-meal-name")).toHaveText(["Vegetable pasta", "Lentil soup"]);
  }
  await page.getByLabel("Find a meal").fill("PASTA");
  assert.equal(await page.locator(".manage-meal-row").count(), 1);
  const remove = page.getByRole("button", {name: "Remove Vegetable pasta from library"});
  page.once("dialog", dialog => dialog.dismiss());
  await remove.click();
  assert.equal((await calls()).length, 4);
  await page.evaluate(() => { (window as any).outcome = true; });
  page.once("dialog", dialog => {
    assert.match(dialog.message(), /Planned meals will stay unchanged/);
    void dialog.accept();
  });
  await remove.click();
  await page.waitForFunction(() => (window as any).calls.length === 5);
  await release();
  await remove.waitFor({state: "detached"});
  assert.equal(await page.getByTestId("planned").textContent(), "Planned: Vegetable pasta");
  await page.setViewportSize({width: 360, height: 800});
  assert.ok(await page.locator(".meal-library-add-controls").evaluate(el => el.getBoundingClientRect().right <= window.innerWidth));
  assert.deepEqual(errors, []);
  console.log("Library settings smoke passed: trim/empty, Enter, pending duplicate guard, true-only clear/feedback, failure retention, search, confirmed removal, planned display preservation, mobile fit.");
} finally {
  await browser?.close();
  await server.close();
  await rm(root, {recursive: true, force: true});
}
