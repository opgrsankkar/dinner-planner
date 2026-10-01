// Run after npm run build. Uses only an isolated synthetic DB and fake Todoist.
import { chromium, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'slot-video-'));
const output = process.env.SLOT_VIDEO_DIR ?? '/home/hermes-admin/.hermes/cache/scratch/dinner-motion-slot-videos';
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
async function noSelection(page: Page) {
  assert.ok(await page.evaluate(() => !window.getSelection()?.toString() && [...document.querySelectorAll<HTMLInputElement>('.slot-name')].every(input => input.selectionStart === input.selectionEnd)), 'No document or input selection during/after drag');
}
async function order(page: Page) { return page.locator('.slot-name').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)); }
async function checkOrder(page: Page, names: string[]) {
  await page.waitForFunction(names => JSON.stringify([...document.querySelectorAll<HTMLInputElement>('.slot-name')].map(input => input.value)) === JSON.stringify(names), names);
  assert.deepEqual(await order(page), names);
}
async function gesture(page: Page, mobile: boolean, from: number, to: number, cancel = false) {
  const handle = page.locator('.slot-name').nth(from);
  await handle.scrollIntoViewIfNeeded();
  const start = (await handle.boundingBox())!;
  const end = (await page.locator('.slot-edit-row').nth(to).boundingBox())!;
  const x = start.x + start.width / 2, y = start.y + start.height / 2;
  const targetY = end.y + end.height / 2;
  const rows = page.locator('.slot-edit-row');
  const id = await rows.nth(from).getAttribute('data-slot-id');
  const neighborId = await rows.nth(to).getAttribute('data-slot-id');
  const dragged = page.locator(`[data-slot-id="${id}"]`);
  const neighbor = page.locator(`[data-slot-id="${neighborId}"]`);
  const before = (await dragged.boundingBox())!;
  const neighborBefore = (await neighbor.boundingBox())!;
  const cdp = mobile ? await page.context().newCDPSession(page) : undefined;
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
  }
  if (mobile) await page.waitForTimeout(350);
  let neighborAnimated = false;
  for (let step = 1; step <= 32; step++) {
    const nextY = y + (targetY - y) * step / 32;
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: nextY }] });
    else await page.mouse.move(x, nextY);
    await page.waitForTimeout(55);
    await noSelection(page);
    const neighborNow = (await neighbor.boundingBox())!;
    const shift = Math.abs(neighborNow.y - neighborBefore.y);
    if (shift > 2 && shift < Math.abs(targetY - y) / Math.abs(to - from) - 2) neighborAnimated = true;
    if (step === 12) {
      const held = (await dragged.boundingBox())!;
      assert.ok(Math.abs(held.y - before.y) > 15, 'Dragged row visibly moves while held');
      assert.ok(Math.abs((held.y - before.y) - (nextY - y)) < 12, 'Dragged row follows actual input');
    }
  }
  await page.waitForTimeout(220);
  const held = (await dragged.boundingBox())!;
  const neighborHeld = (await neighbor.boundingBox())!;
  assert.ok(Math.abs(held.y - before.y) > 30, 'Dragged row moved before release');
  assert.ok(Math.abs(neighborHeld.y - neighborBefore.y) > 20, 'Neighbor slid before release');
  assert.ok(neighborAnimated, 'Neighbor has intermediate animated positions while crossing');
  assert.equal(await dragged.getAttribute('data-dragging'), 'true', 'Assertions run during held drag');
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else await page.mouse.up();
  await page.waitForTimeout(500);
  await noSelection(page);
  assert.equal(await page.locator('[data-dragging]').count(), 0, 'Drag settles');
  const settled = (await dragged.boundingBox())!;
  assert.ok(Math.abs(settled.y - (cancel ? before.y : end.y)) < 2, 'Row settles into its layout position');

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
  for (const mobile of [true, false]) {
    // Authenticate before recording so no password or login screen appears.
    const setup = await browser.newContext();
    const login = await setup.newPage();
    await login.goto(origin);
    await login.getByLabel('Password', { exact: true }).fill(password).catch(error => { console.error('Login startup:', logs, '\nPage:', error.message); throw error; });
    await login.getByRole('button', { name: 'Sign in', exact: true }).click();
    await login.getByRole('heading', { name: 'Meal library' }).waitFor();
    const snapshot = await (await setup.request.get(`${origin}/api/board`)).json();
    const csrf = snapshot.csrf;
    const seeded = snapshot.slots.map((slot: { id: string }, index: number) => ({ id: slot.id, name: ['Breakfast', 'Lunch', 'Dinner'][index], time: ['08:00', '13:00', '19:00'][index] }));
    const response = await setup.request.post(`${origin}/api/settings/slots`, { headers: { 'X-CSRF-Token': csrf, Origin: origin }, data: { slots: seeded, revision: snapshot.settings.revision } });
    assert.ok(response.ok(), await response.text());
    const storageState = await setup.storageState();
    await setup.close();
    const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
    const context = await browser.newContext({ storageState, viewport, isMobile: mobile, hasTouch: mobile, recordVideo: { dir: output, size: viewport } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    console.log(`Starting ${mobile ? 'touch' : 'mouse'} checks`);
    await page.goto(`${origin}/settings`);
    await openSlots(page);
    await page.locator('.slot-settings-section').scrollIntoViewIfNeeded();
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    const actions = await page.locator('.settings-actions').boundingBox();
    const firstRow = await page.locator('.slot-edit-row').first().boundingBox();
    assert.ok(actions && firstRow && actions.y + actions.height <= firstRow.y, 'Actions stay above list');
    assert.equal(await page.locator('[data-hint]').count(), 1, 'Only first row hints');
    await page.waitForTimeout(900);
    await gesture(page, mobile, 0, 2);
    await checkOrder(page, ['Lunch', 'Dinner', 'Breakfast']);
    assert.equal(await page.locator('.reorder-actions-open').count(), 0, 'Drag must not toggle buttons');
    await page.waitForTimeout(900);
    await page.route('**/api/settings/slots', async route => { await new Promise(resolve => setTimeout(resolve, 600)); await route.continue(); });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Saving', exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isDisabled(), 'Pending save disables Revert');
    assert.ok(await page.locator('.slot-name').first().isDisabled(), 'Pending save locks draft');
    await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
    await page.waitForTimeout(1100);
    await page.reload();
    await openSlots(page);
    await page.locator('.slot-settings-section').scrollIntoViewIfNeeded();
    await checkOrder(page, ['Lunch', 'Dinner', 'Breakfast']);
    const persisted = await (await context.request.get(`${origin}/api/board`)).json();
    assert.deepEqual(persisted.slots.map((slot: { name: string }) => slot.name), ['Lunch', 'Dinner', 'Breakfast']);
    await page.waitForTimeout(900);
    await gesture(page, mobile, 2, 0);
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    await checkOrder(page, ['Lunch', 'Dinner', 'Breakfast']);
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled());
    await page.waitForTimeout(1100);
    const video = page.video()!;
    await context.close();
    const destination = join(output, `${mobile ? 'mobile' : 'desktop'}-motion-slot-reorder-${Date.now()}.webm`);
    await rename(await video.path(), destination);
    console.log(`Verified drag, Save, reload persistence and Revert: ${destination}`);
    assert.deepEqual(errors, []);
    // Additional trusted input regressions outside the clean demonstration video.
    const checks = await browser.newContext({ storageState, viewport, isMobile: mobile, hasTouch: mobile });
    const check = await checks.newPage();
    check.setDefaultTimeout(10000);
    console.log('Checking cancellation, buttons, editing and reduced motion', { mobile });
    await check.goto(`${origin}/settings`);
    await openSlots(check);
    await check.locator('.slot-settings-section').scrollIntoViewIfNeeded();
    if (mobile) {
      await check.getByLabel('Slot label 1', { exact: true }).fill('Lunch draft');
      await gesture(check, true, 0, 2, true);
      await checkOrder(check, ['Lunch draft', 'Dinner', 'Breakfast']);
      await check.getByRole('button', { name: 'Revert', exact: true }).click();
      assert.equal(await check.locator('[data-dragging], [data-drop-target]').count(), 0);
      await gesture(check, true, 0, 2);
      await checkOrder(check, ['Dinner', 'Breakfast', 'Lunch']);
      await check.getByRole('button', { name: 'Revert', exact: true }).click();

    }
    await check.locator('.slot-settings-section').scrollIntoViewIfNeeded();
    await check.getByRole('button', { name: 'Move Lunch down', exact: true }).click();
    await checkOrder(check, ['Dinner', 'Lunch', 'Breakfast']);
    await check.getByRole('button', { name: 'Revert', exact: true }).click();
    await check.getByLabel('Slot label 1', { exact: true }).click();
    await check.keyboard.press('ControlOrMeta+A');
    await check.keyboard.type('Lunch draft');
    await checkOrder(check, ['Lunch draft', 'Dinner', 'Breakfast']);
    if (!mobile) {
      await check.getByRole('button', { name: 'Meal library', exact: true }).click();
      await check.getByRole('button', { name: 'Meal slots', exact: true }).click();
      assert.equal(await check.locator('[data-hint]').count(), 1, 'Reopening hints only the first row');
      assert.equal(await check.getByLabel('Slot label 1', { exact: true }).inputValue(), 'Lunch draft', 'Navigation preserves draft');
    }
    await check.getByRole('button', { name: 'Revert', exact: true }).click();
    await check.getByLabel('Slot time 1', { exact: true }).fill('12:30');
    assert.equal(await check.getByLabel('Slot time 1', { exact: true }).inputValue(), '12:30');
    await check.getByRole('button', { name: 'Revert', exact: true }).click();
    await check.getByRole('button', { name: '+ Add slot', exact: true }).click();
    const added = check.locator('.slot-edit-row').last();
    await added.locator('.slot-name').fill('Synthetic snack');
    await added.locator('.slot-time').fill('16:00');
    const addedId = await added.getAttribute('data-slot-id');
    const addedHeight = (await added.boundingBox())!.height;
    await added.locator('.remove-slot').click();
    await check.waitForTimeout(80);
    const exiting = check.locator(`[data-slot-id="${addedId}"]`);
    assert.equal(await exiting.count(), 1, 'Deleted row animates before removal');
    assert.ok((await exiting.boundingBox())!.height < addedHeight, 'Deleted row collapses');
    await check.locator(`[data-slot-id="${addedId}"]`).waitFor({ state: 'detached' });
    await check.emulateMedia({ reducedMotion: 'reduce' });
    await check.reload(); await openSlots(check);
    await check.waitForTimeout(100);
    assert.ok(await check.locator('.slot-edit-row').first().evaluate(el => !el.style.transform || el.style.transform === 'none'), 'Reduced motion disables vertical hint');
    if (mobile) {
      await check.evaluate(() => { const spacer = document.createElement('div'); spacer.style.height = '1600px'; document.body.append(spacer); window.scrollTo(0, 0); });
      await check.locator('.slot-name').first().scrollIntoViewIfNeeded();
      const box = (await check.locator('.slot-name').first().boundingBox())!;
      const beforeScroll = await check.evaluate(() => window.scrollY);
      const cdp = await checks.newCDPSession(check);
      const x = box.x + 10, y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 20 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await check.waitForTimeout(200);
      assert.ok(await check.evaluate(() => window.scrollY) > beforeScroll, 'Quick swipe on row scrolls');
      assert.equal(await check.locator('[data-dragging]').count(), 0);
      await cdp.detach();
    }
    await checks.close();
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
  await rm(directory, { recursive: true, force: true });
}
