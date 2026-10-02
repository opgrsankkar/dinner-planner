import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const artifacts = resolve(process.env.COMPARISON_ARTIFACTS ?? ".local/comparison/issue-33");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "issue-33-browser-"));
const project = resolve(import.meta.dirname, "..");
await writeFile(join(root, "index.html"), '<style>:root{--paper:#edbb97;--surface:#fff5e9;--pink:#f5d9df;--ink:#553449;--line:#55344933}html[data-theme=dark]{--paper:#352b32;--surface:#4d3b46;--ink:#f5d9df;--line:#f5d9df44}body{margin:0;background:var(--paper);color:var(--ink)}</style><div id="root"></div><script type="module" src="/harness.tsx"></script>');
await writeFile(join(root, "harness.tsx"), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MealLibrarySettings } from '/@fs/${project}/src/settings/MealLibrarySettings.tsx';
declare global { interface Window { issueCalls: {path:string;body:any}[]; issueOutcome: any; issueConfirmations: string[] } }
function Harness() {
  const [failure, setFailure] = useState('');
  const [library, setLibrary] = useState(() => {
    try { return JSON.parse(localStorage.getItem('issue-33-library') || 'null') || [{id:'pasta-id',name:'Vegetable pasta'},{id:'soup-id',name:'Lentil soup'}]; } catch { return [{id:'pasta-id',name:'Vegetable pasta'},{id:'soup-id',name:'Lentil soup'}]; }
  });
  window.issueCalls = window.issueCalls || [];
  window.issueOutcome = true;
  window.issueConfirmations = window.issueConfirmations || [];
  window.confirm = message => { window.issueConfirmations.push(message); return true; };
  return <>{failure && <p role="alert">{failure}</p>}<MealLibrarySettings library={library} action={async (path, body) => {
    window.issueCalls.push({path,body});
    if (window.issueOutcome !== true) { setFailure('Synthetic handled failure'); return false; }
    setFailure('');
    let next = library;
    if (path === '/api/library/rename') next = library.map(meal => meal.id === body.mealId ? {...meal,name:body.name} : meal);
    if (path === '/api/library/remove') next = library.filter(meal => meal.id !== body.mealId);
    if (path === '/api/library') next = [...library,{id:body.name,name:body.name}];
    localStorage.setItem('issue-33-library', JSON.stringify(next)); setLibrary(next); return true;
  }} /></>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`);
const server = await createServer({ configFile: false, root,
  resolve: { alias: { "react-dom": join(project, "node_modules/react-dom"), react: join(project, "node_modules/react") } },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root, project] } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]!);
  const row = (id: string) => page.locator(`.folio-library-row[data-meal-id="${id}"]`);
  const calls = () => page.evaluate(() => (window as any).issueCalls);
  const pasta = row("pasta-id");
  await expect(pasta).toBeVisible();

  // Intro gesture hint moves and returns; reduced motion disables the animation.
  await expect(pasta).toHaveClass(/is-hinting/);
  const hintSamples = await pasta.locator(".folio-library-content").evaluate(async el => {
    const animation = el.getAnimations()[0];
    if (!animation) return { started: false, moved: false, returned: false };
    animation.pause(); animation.currentTime = 800;
    const moved = getComputedStyle(el).transform !== "matrix(1, 0, 0, 1, 0, 0)";
    animation.currentTime = 2200;
    return { started: true, moved, returned: getComputedStyle(el).transform === "matrix(1, 0, 0, 1, 0, 0)" };
  });
  assert.deepEqual(hintSamples, { started: true, moved: true, returned: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await pasta.locator(".folio-library-content").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(2400);
  await expect(pasta).not.toHaveClass(/is-hinting/);

  // Vertical movement and a short horizontal movement reset without revealing an action.
  await pasta.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 300, clientY: 120 });
  await pasta.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 1, clientX: 306, clientY: 175 });
  await pasta.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 1, clientX: 306, clientY: 175 });
  await expect(pasta).not.toHaveClass(/is-revealed/);
  await pasta.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 300, clientY: 120 });
  await pasta.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 2, clientX: 330, clientY: 122 });
  await pasta.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 2, clientX: 330, clientY: 122 });
  await expect(pasta).not.toHaveClass(/is-revealed/);
  await pasta.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 5, clientX: 330, clientY: 120 });
  await pasta.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 5, clientX: 245, clientY: 121 });
  await pasta.dispatchEvent("pointercancel", { pointerType: "touch", pointerId: 5, clientX: 245, clientY: 121 });
  await expect(pasta).not.toHaveClass(/is-revealed/);
  assert.equal((await calls()).length, 0, "gesture alone must not mutate the library");

  await page.setViewportSize({ width: 390, height: 844 });
  // A completed left swipe only reveals Delete. Activation is explicit and confirmed.
  await pasta.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 3, clientX: 330, clientY: 120 });
  await pasta.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 3, clientX: 245, clientY: 121 });
  await pasta.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 3, clientX: 245, clientY: 121 });
  await expect(pasta).toHaveClass(/is-revealed-delete/);
  await expect(pasta.locator(".folio-library-content")).toHaveCSS("transform", "matrix(1, 0, 0, 1, -88, 0)");
  await expect(pasta.locator(".folio-library-delete")).toHaveCSS("opacity", "1");
  assert.match(await pasta.locator(".folio-library-delete").evaluate(el => getComputedStyle(el).backgroundColor), /201, 79, 93/);
  assert.equal((await calls()).length, 0);
  await page.screenshot({ path: join(artifacts, "mobile-delete-revealed.png"), fullPage: true });
  await pasta.getByRole("button", { name: "Delete Vegetable pasta" }).click();
  assert.match((await page.evaluate(() => (window as any).issueConfirmations[0]!)), /Planned meals will stay unchanged/);
  assert.deepEqual(await calls(), [{ path: "/api/library/remove", body: { mealId: "pasta-id" } }]);
  await expect(pasta).toHaveCount(0);

  // Hover and keyboard focus expose controls; keyboard activation opens the rename editor.
  const soup = row("soup-id");
  await soup.hover();
  await expect(soup.getByRole("button", { name: "Edit Lentil soup" })).toHaveCSS("opacity", "1");
  await expect(soup.getByRole("button", { name: "Delete Lentil soup" })).toHaveCSS("opacity", "1");
  await page.getByLabel("Search meals", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "＋ Add Meal", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(soup.getByRole("button", { name: "Edit Lentil soup" })).toBeFocused();
  await page.keyboard.press("Enter");
  const edit = page.getByRole("textbox", { name: "New name for Lentil soup" });
  await expect(edit).toBeFocused();
  await edit.fill("  Chickpea   curry  ");
  await page.evaluate(() => { (window as any).issueOutcome = false; });
  await edit.press("Enter");
  await expect(edit).toHaveValue("  Chickpea   curry  ");
  await expect(page.getByRole("alert")).toContainText("Synthetic handled failure");
  await page.evaluate(() => { (window as any).issueOutcome = true; });
  await edit.press("Enter");
  await expect(row("soup-id").locator(".folio-library-name")).toHaveText("Chickpea curry");
  assert.deepEqual((await calls()).slice(-2), [
    { path: "/api/library/rename", body: { mealId: "soup-id", name: "Chickpea curry" } },
    { path: "/api/library/rename", body: { mealId: "soup-id", name: "Chickpea curry" } },
  ]);
  await expect(page.getByLabel("Search meals", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifacts, "mobile-light.png"), fullPage: true });
  await page.reload();
  await expect(row("soup-id").locator(".folio-library-name")).toHaveText("Chickpea curry");

  // Filter changes preserve row identity, and right swipe exposes the blue edit affordance.
  const search = page.getByLabel("Search meals", { exact: true });
  await search.fill("CURRY");
  await expect(page.locator(".folio-library-row")).toHaveCount(1);
  const filtered = row("soup-id");
  await filtered.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 4, clientX: 70, clientY: 120 });
  await filtered.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 4, clientX: 155, clientY: 121 });
  await filtered.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 4, clientX: 155, clientY: 121 });
  await expect(filtered).toHaveClass(/is-revealed-edit/);
  await expect(filtered.locator(".folio-library-content")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 88, 0)");
  await expect(filtered.locator(".folio-library-edit")).toHaveCSS("opacity", "1");
  assert.match(await filtered.locator(".folio-library-edit").evaluate(el => getComputedStyle(el).backgroundColor), /55, 118, 197/);
  assert.equal(await filtered.getAttribute("data-meal-id"), "soup-id");
  await page.screenshot({ path: join(artifacts, "mobile-edit-revealed.png"), fullPage: true });

  // Both accepted Apricot Folio themes keep the reveal readable and restore layout at rest.
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  assert.equal(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(53, 43, 50)");
  await page.screenshot({ path: join(artifacts, "mobile-dark-edit-revealed.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  assert.equal(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(237, 187, 151)");
  await page.keyboard.press("Escape");
  await search.fill("");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(artifacts, "desktop-light.png"), fullPage: true });
  await expect(page.locator(".folio-library-row")).toHaveCount(1);
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`Issue #33 browser regression passed: touch left/right reveal, explicit confirmed delete, keyboard edit, hover/focus access, vertical/short/cancel reset, error draft retention, rename persistence after reload, filter identity, reduced motion and light/dark screenshots. Artifacts: ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
