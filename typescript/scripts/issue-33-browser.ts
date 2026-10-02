// After npm run build: node --import tsx scripts/issues-library-smoke.ts
// Uses only an isolated synthetic DB and fake Todoist.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'issues-library-'));
const password = randomUUID();
const port = process.env.FOLIO_INPUTS_PORT ?? await new Promise<string>((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    probe.close(() => resolve(String(address.port)));
  });
});
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: {
  ...process.env, TODOIST_MODE: 'fake', TODOIST_TOKEN: '', TODOIST_TOKEN_FILE: '',
  APP_PASSWORD: password, COOKIE_SECURE: 'false', ALLOWED_HOSTS: '127.0.0.1,localhost',
  DATABASE_PATH: join(directory, 'planner.sqlite'), PLANNER_DB: join(directory, 'planner.sqlite'),
  FAKE_TODOIST_DB: join(directory, 'provider.sqlite'), FAKE_TODOIST_DELAY_MS: '0',
  FAKE_TODOIST_FAIL_BEFORE: '0', FAKE_TODOIST_LOSE_RESPONSE: '0',
  FAKE_TODOIST_MOVE_FAIL_BEFORE: '0', FAKE_TODOIST_DELETE_FAIL_BEFORE: '0',
  PORT: port, HOST: '127.0.0.1', PLANNER_ORIGIN: origin,
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', c => logs += c);
server.stderr.on('data', c => logs += c);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const artifacts = join(process.cwd(), '.local', 'comparison');
await mkdir(artifacts, { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    assert.equal(server.exitCode, null, `Server exited: ${logs}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, `Server failed: ${logs}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, isMobile: width < 500 });
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    if (width === 1280 && theme === 'light') await page.evaluate(async () => {
      const board = await (await fetch('/api/board')).json();
      for (let i = 0; i < 12; i++) {
        const response = await fetch('/api/library', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': board.csrf }, body: JSON.stringify({ name: `Scroll test meal ${i}` }) });
        if (!response.ok) throw new Error('Synthetic fixture setup failed');
      }
    });
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Meal library', exact: true }).click();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const library = page.locator('.folio-library'), rows = library.locator('.folio-library-row'), first = rows.first();
    await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => el.getAnimations().length)).toBeGreaterThan(0);
    const frames = await first.locator('.folio-library-surface').evaluate(el => (el.getAnimations()[0].effect as KeyframeEffect).getKeyframes());
    assert.ok(frames.some(f => f.transform === 'translateX(-56px)') && frames.some(f => f.transform === 'translateX(56px)'));
    await page.waitForTimeout(2300);
    assert.equal(await first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
    const name = await first.locator('.folio-library-name').innerText(), mealId = await first.getAttribute('data-meal-id');
    let mutations = 0; page.on('request', req => { if (req.method() === 'POST' && /\/api\/library/.test(req.url())) mutations++; });
    const cdp = await context.newCDPSession(page);
    async function swipe(dx: number, dy = 0, cancel = false) {
      await first.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); const box = (await first.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    }
    if (width < 500) {
      await swipe(-80); await expect(first).toHaveAttribute('data-reveal', 'delete');
      await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, -56, 0)');
      await page.screenshot({ path: join(artifacts, `swipe-delete-${theme}.png`) });
      await swipe(80); await expect(first).toHaveAttribute('data-reveal', 'edit');
      await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 56, 0)');
      await page.screenshot({ path: join(artifacts, `swipe-edit-${theme}.png`) });
      for (const [dx, dy, cancel] of [[20, 0, false], [-80, 0, true]] as const) {
        await swipe(dx, dy, cancel); await expect(first).toHaveAttribute('data-reveal', 'closed');
      }
      await first.scrollIntoViewIfNeeded();
      const scrollBefore = await page.evaluate(() => scrollY);
      await swipe(10, -90); await expect(first).toHaveAttribute('data-reveal', 'closed');
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollBefore);
      assert.equal(mutations, 0); await swipe(80);
      await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 56, 0)');
      await first.getByRole('button', { name: `Edit ${name}`, exact: true }).tap();
    } else {
      await first.hover(); assert.equal(await first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
      await page.mouse.move(0, 0); await first.focus(); await page.keyboard.press('ArrowRight');
      await expect(first).toHaveAttribute('data-reveal', 'edit'); await page.keyboard.press('Tab');
      await expect(first.getByRole('button', { name: `Edit ${name}`, exact: true })).toBeFocused(); await page.keyboard.press('Enter');
    }
    const draft = first.getByRole('textbox'); await draft.fill('  '); await draft.press('Enter');
    await expect(first.getByRole('alert')).toContainText('between 1 and 120'); assert.equal(mutations, 0);
    const renamed = `Renamed ${width} ${theme}`; await draft.fill(renamed);
    await page.route('**/api/library/rename', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Synthetic rename failure"}' }));
    await draft.press('Enter'); await expect(draft).toBeEnabled(); await expect(draft).toHaveValue(renamed);
    await expect(page.getByText('Synthetic rename failure', { exact: true })).toBeVisible(); await page.unroute('**/api/library/rename');
    await draft.fill(`  ${renamed}  `); await draft.press('Enter'); await expect(first.locator('.folio-library-name')).toHaveText(renamed);
    assert.equal(await first.getAttribute('data-meal-id'), mealId);
    await page.reload(); await page.getByRole('button', { name: 'Meal library', exact: true }).click();
    const updated = library.locator(`[data-meal-id="${mealId}"]`); await expect(updated.locator('.folio-library-name')).toHaveText(renamed);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await updated.getByRole('button', { name: `Edit ${renamed}`, exact: true }).focus(); await page.keyboard.press('Enter');
    await updated.getByRole('textbox').fill('Draft kept through polling');
    assert.equal(await page.evaluate(async () => {
      const board = await (await fetch('/api/board')).json();
      return (await fetch('/api/library/shuffle', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': board.csrf }, body: '{}' })).status;
    }), 202);
    await page.waitForTimeout(1500);
    await expect(updated.getByRole('textbox')).toHaveValue('Draft kept through polling'); await updated.getByRole('textbox').press('Escape');
    await library.getByRole('searchbox').fill(renamed.toUpperCase()); await expect(rows).toHaveCount(1); await library.getByRole('searchbox').fill('');
    page.once('dialog', dialog => dialog.dismiss()); await updated.getByRole('button', { name: `Remove ${renamed} from library`, exact: true }).focus(); await page.keyboard.press('Space');
    await expect(updated).toHaveCount(1); page.once('dialog', dialog => dialog.accept()); await page.keyboard.press('Enter'); await expect(updated).toHaveCount(0);
    await library.getByRole('searchbox').fill(`Added ${width} ${theme}`); await library.getByRole('searchbox').press('Enter'); await expect(library.getByRole('searchbox')).toHaveValue('');
    await page.route('**/api/library', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Synthetic add failure"}' }));
    await library.getByRole('searchbox').fill('Keep add draft'); await library.getByRole('searchbox').press('Enter');
    await expect(library.getByRole('searchbox')).toBeEnabled(); await expect(library.getByRole('searchbox')).toHaveValue('Keep add draft'); await page.unroute('**/api/library');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload(); await page.getByRole('button', { name: 'Meal library', exact: true }).click();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await page.waitForTimeout(600);
    await expect(library.locator('.folio-library-hint')).toBeVisible();
    assert.equal(await rows.first().locator('.folio-library-surface').evaluate(el => el.getAnimations().length), 0);
    assert.equal(await rows.first().locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(artifacts, `settings-${width}-${theme}-reduced.png`), fullPage: true }); assert.deepEqual(errors, []);
    console.log(`PASS ${width}/${theme}: intro, explicit actions, keyboard/confirmation, rename reload identity polling/reorder, add/error drafts, reduced motion, no overflow${width < 500 ? ', CDP touch left/right/short/cancel/vertical' : ', hover'}`);
    await context.close();
  }
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
  await writeFile(join(artifacts, 'server.log'), logs); await rm(directory, { recursive: true, force: true });
}
