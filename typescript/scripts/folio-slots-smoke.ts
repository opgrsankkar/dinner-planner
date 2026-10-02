// Run after npm run build. Uses only an isolated synthetic DB and fake Todoist.
import { chromium, type Page, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
await mkdir('.local/issue20', { recursive: true });
const directory = await mkdtemp(join(process.cwd(), '.local/issue20/slot-sort-'));
const output = process.env.SLOT_VIDEO_DIR ?? join(process.cwd(), '.local/issue20/artifacts');
await mkdir(output, { recursive: true });
const password = randomUUID();
const port = process.env.SLOT_VIDEO_PORT ?? await new Promise<string>((resolve, reject) => {
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
async function openSlots(page: Page) {
  if (!await page.locator('.slot-name').first().isVisible()) await page.getByRole('button', { name: 'Meal slots', exact: true }).click();
  await page.locator('.slot-name').first().waitFor();
}
async function checkOrder(page: Page, names: string[]) {
  await page.waitForFunction(names => JSON.stringify([...document.querySelectorAll<HTMLInputElement>('.slot-name')].map(input => input.value)) === JSON.stringify(names), names);
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    assert.equal(server.exitCode, null, `Server exited: ${logs}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, `Server failed: ${logs}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [375, 390, 1280]) {
    const setup = await browser.newContext();
    const login = await setup.newPage();
    await login.goto(origin);
    await login.getByLabel('Password', { exact: true }).fill(password);
    await login.getByRole('button', { name: 'Sign in', exact: true }).click();
    await login.getByRole('heading', { name: 'Meal library' }).waitFor();
    const snapshot = await (await setup.request.get(`${origin}/api/board`)).json();
    const seeded = snapshot.slots.map((slot: { id: string }, index: number) => ({ id: slot.id, name: ['Breakfast', 'Lunch', 'Dinner'][index], time: ['08:00', '13:00', '19:00'][index] }));
    const response = await setup.request.post(`${origin}/api/settings/slots`, { headers: { 'X-CSRF-Token': snapshot.csrf, Origin: origin }, data: { slots: seeded, revision: snapshot.settings.revision } });
    assert.ok(response.ok(), await response.text());
    const storageState = await setup.storageState();
    await setup.close();
    const viewport = { width, height: width < 700 ? 844 : 900 };
    const context: BrowserContext = await browser.newContext({ storageState, viewport, isMobile: width < 700, hasTouch: width < 700, recordVideo: { dir: output, size: viewport } });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/settings`);
    await openSlots(page);
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    await page.waitForTimeout(500);
    const actionBoxes = await Promise.all(['+ Add slot', 'Save', 'Revert'].map(name => page.getByRole('button', { name, exact: true }).boundingBox()));
    assert.ok(actionBoxes.every(box => box && Math.abs(box.y - actionBoxes[0]!.y) < 3), 'All actions on one line');
    assert.equal(await page.locator('.slot-order-controls, .slot-edit-grip, [data-hint]').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^Move .* (up|down)$/ }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    const breakfastId = seeded[0].id;
    const breakfast = page.locator(`[data-slot-id="${breakfastId}"]`);
    const lunch = page.locator(`[data-slot-id="${seeded[1].id}"]`);
    await page.screenshot({ path: join(output, `slots-${width}.png`), fullPage: true });
    // Capture actual intermediate layout transforms after the time edit.
    await page.evaluate(`
      window.slotSamples = [];
      const until = performance.now() + 900;
      function sample() {
        document.querySelectorAll('.slot-edit-row').forEach(row => window.slotSamples.push(row.style.transform));
        if (performance.now() < until) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    `);
    await breakfast.locator('.slot-time').fill('20:00');
    await checkOrder(page, ['Lunch', 'Dinner', 'Breakfast']);
    await page.waitForTimeout(950);
    assert.ok(await page.evaluate(() => (window as unknown as { slotSamples: string[] }).slotSamples.some(value => /translate/.test(value) && !/translateY\(0px\)/.test(value))), 'Time edit visibly animates row movement');
    assert.equal(await breakfast.locator('.slot-time').inputValue(), '20:00', 'Stable ID keeps edited value');
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    await breakfast.locator('.slot-time').fill('13:00');
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Duplicate time invalid');
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    // Delete a native time segment, then edit another complete time. Neither
    // may reorder while the partial native input reports an empty value.
    await breakfast.locator('.slot-time').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    assert.equal(await breakfast.locator('.slot-time').inputValue(), '', 'Native partial time');
    await lunch.locator('.slot-time').fill('07:00');
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled());
    await breakfast.locator('.slot-time').fill('08:00');
    await checkOrder(page, ['Lunch', 'Breakfast', 'Dinner']);
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    await page.getByRole('button', { name: '+ Add slot', exact: true }).click();
    const addedId = await page.locator('.slot-edit-row').last().getAttribute('data-slot-id');
    const added = page.locator(`[data-slot-id="${addedId}"]`);
    await added.locator('.slot-name').fill('Snack');
    await added.locator('.slot-time').fill('16:00');
    await checkOrder(page, ['Breakfast', 'Lunch', 'Snack', 'Dinner']);
    await added.locator('.remove-slot').click();
    await added.waitFor({ state: 'detached' });
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Remove added slot restores clean baseline');
    await breakfast.locator('.slot-time').fill('20:00');
    let fail = true;
    await page.route('**/api/settings/slots', async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic save failure' }) }); }
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Saving', exact: true }).waitFor();
    assert.ok(await breakfast.locator('.slot-time').isDisabled());
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Save failed', exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Save failed', exact: true }).isEnabled());
    await page.screenshot({ path: join(output, `slots-${width}-retry.png`), fullPage: true });
    await page.getByRole('button', { name: 'Save failed', exact: true }).click();
    await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
    await page.waitForTimeout(1100);
    await page.reload(); await openSlots(page);
    await checkOrder(page, ['Lunch', 'Dinner', 'Breakfast']);
    const persisted = await (await context.request.get(`${origin}/api/board`)).json();
    assert.deepEqual(persisted.slots.map((slot: { name: string }) => slot.name), ['Lunch', 'Dinner', 'Breakfast']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload(); await openSlots(page);
    await breakfast.locator('.slot-time').fill('06:00');
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.locator('.slot-edit-row').evaluateAll(rows => rows.every(row => !((row as HTMLElement).style.transform) || (row as HTMLElement).style.transform === 'none')), 'Reduced motion uses immediate layout');
    await page.screenshot({ path: join(output, `slots-${width}-reduced.png`), fullPage: true });
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    await checkOrder(page, ['Lunch', 'Dinner', 'Breakfast']);
    assert.deepEqual(errors, []);
    const video = page.video()!;
    await context.close();
    const destination = join(output, `slots-${width}-chronological.webm`);
    await rename(await video.path(), destination);
    console.log(`PASS ${width}px: chronological animation, equal/partial times, add/remove, revert, save/retry/reload, reduced motion; ${destination}`);
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
  await rm(directory, { recursive: true, force: true });
}
