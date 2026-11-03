// Production browser regression using only a temporary local-provider database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Locator } from '@playwright/test';
const directory = await mkdtemp(join(tmpdir(), 'planner-drag-'));
const origin = 'http://127.0.0.1:3196';
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env,
  TODOIST_MODE: 'local', TODOIST_TOKEN: '', TODOIST_TOKEN_FILE: '',
  DATABASE_PATH: join(directory, 'planner.sqlite'), PLANNER_ORIGIN: origin,
  ALLOWED_HOSTS: '127.0.0.1', HOST: '127.0.0.1', PORT: '3196',
}, stdio: 'inherit' });
const browser = await chromium.launch();
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    if (i > 100) throw new Error('server startup failed');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok((await post('/api/library', { name: 'Gesture dinner' })).ok);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(origin);
  const library = page.getByRole('button', { name: 'Plan Gesture dinner', exact: true });
  await library.tap();
  await page.locator('#plan-title').waitFor();
  await page.getByRole('button', { name: 'Plan meal', exact: true }).click();
  const card = page.locator('.meal-chip[role=button]').first();
  await card.waitFor();
  const cdp = await context.newCDPSession(page);
  const point = async (locator: Locator) => {
    const box = await locator.boundingBox(); assert.ok(box);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const touch = (type: 'touchStart' | 'touchEnd' | 'touchMove' | 'touchCancel', p?: {x: number; y: number}) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: p ? [{ ...p, id: 1 }] : [],
  });
  const start = async (locator: Locator) => touch('touchStart', await point(locator));
  const end = () => touch('touchEnd');
  // A tap opens after the double-press window; keyboard still opens immediately.
  await card.tap();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.locator('#plan-title').waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const originalId = await card.getAttribute('data-card-id');
  const originalCell = await card.evaluate(el => el.closest('td')!.dataset.date);
  const destination = page.locator(`.meal-cell:not([data-date="${originalCell}"])`).first();
  // Tap then hold picks up a copy and leaves the original untouched.
  await card.tap();
  await start(card);
  await page.locator('.touch-drag-ghost .drag-copy-badge').waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await touch('touchMove', await point(destination));
  await end();
  await page.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 2);
  assert.equal(await page.locator(`[data-card-id="${originalId}"]`).evaluate(el => el.closest('td')!.dataset.date), originalCell);
  // Single hold remains a move, without a copy badge.
  const original = page.locator(`[data-card-id="${originalId}"]`);
  await start(original);
  await page.locator('.touch-drag-ghost').waitFor();
  assert.equal(await page.locator('.drag-copy-badge').count(), 0);
  await touch('touchMove', await point(destination));
  await end();
  await page.waitForFunction(({id, date}) => document.querySelector(`[data-card-id="${id}"]`)?.closest('td')?.dataset.date !== date, { id: originalId, date: originalCell });
  await page.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 2);
  // Moving before pickup stays a scroll; cancelled holds do not place anything.
  await page.setViewportSize({ width: 390, height: 844 });
  await original.scrollIntoViewIfNeeded();
  const p = await point(original);
  await touch('touchStart', p);
  await touch('touchMove', { x: p.x, y: p.y - 35 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.touch-drag-ghost').count(), 0);
  await end();
  await original.scrollIntoViewIfNeeded();
  await start(original);
  await page.locator('.touch-drag-ghost').waitFor();
  await touch('touchCancel');
  assert.equal(await page.locator('.touch-drag-ghost').count(), 0);
  // The same tap-hold copy also works on a phone-sized board.
  await original.tap();
  await start(original);
  await page.locator('.touch-drag-ghost .drag-copy-badge').waitFor();
  await end();
  await page.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 3);
  // Non-drag copy alternative.
  await original.scrollIntoViewIfNeeded();
  await original.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Copy meal', exact: true }).click();
  assert.match(await page.locator('#plan-title').innerText(), /^Copy /);
  await page.getByRole('button', { name: 'Copy meal', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 4);
  // Keep the primary finger down while a second finger taps week arrows.
  const shiftDate = (date: string, days: number) => {
    const value = new Date(date + 'T12:00:00Z');
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const firstDate = (await page.locator('.meal-cell').first().getAttribute('data-date'))!;
  await original.scrollIntoViewIfNeeded();
  let held = { ...await point(original), id: 1 };
  const multi = (type: 'touchStart' | 'touchEnd' | 'touchMove', points: {x: number; y: number; id: number}[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const tapWeek = async (label: string, expected: string) => {
    const secondary = { ...await point(page.getByRole('button', { name: label, exact: true })), id: 2 };
    await multi('touchStart', [held, secondary]);
    await multi('touchEnd', [secondary]);
    await page.waitForFunction(date => document.querySelector('.meal-cell')?.getAttribute('data-date') === date, expected);
    assert.equal(await page.locator('.touch-drag-ghost').count(), 1);
    // No synthesized click should navigate a second time.
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.meal-cell').first().getAttribute('data-date'), expected);
  };
  await start(original);
  await page.locator('.touch-drag-ghost').waitFor();
  // A second finger sliding off an arrow must not turn into a week change.
  const arrow = { ...await point(page.getByRole('button', { name: 'Next week', exact: true })), id: 2 };
  const slipped = { ...arrow, x: arrow.x - 25 };
  await multi('touchStart', [held, arrow]);
  await multi('touchMove', [held, slipped]);
  await multi('touchEnd', [slipped]);
  assert.equal(await page.locator('.meal-cell').first().getAttribute('data-date'), firstDate);
  assert.equal(await page.locator('.touch-drag-ghost').count(), 1);
  await tapWeek('Next week', shiftDate(firstDate, 7));
  await page.waitForFunction(id => !document.querySelector(`[data-card-id="${id}"]`), originalId);
  await tapWeek('Next week', shiftDate(firstDate, 14));
  await tapWeek('Previous week', shiftDate(firstDate, 7));
  const nextCell = page.locator('.meal-cell').first();
  held = { ...await point(nextCell), id: 1 };
  await multi('touchMove', [held]);
  await end();
  await original.waitFor();
  assert.equal(await original.evaluate(el => el.closest('td')!.dataset.date), shiftDate(firstDate, 7));
  await page.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 1);
  // Copy back across a week boundary, retaining the source in the other week.
  await original.tap();
  await start(original);
  held = { ...await point(original), id: 1 };
  await page.locator('.touch-drag-ghost .drag-copy-badge').waitFor();
  await tapWeek('Previous week', firstDate);
  held = { ...await point(page.locator('.meal-cell').first()), id: 1 };
  await multi('touchMove', [held]);
  await end();
  await page.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 4);
  const nextBoard = await (await fetch(origin + '/api/board?week=' + shiftDate(firstDate, 7))).json();
  assert.equal(nextBoard.cards.filter((card: {id: string}) => card.id === originalId).length, 1);
  // Releasing the meal before the navigation finger must not switch weeks later.
  const releaseCard = page.locator('.meal-chip[role=button]').first();
  held = { ...await point(releaseCard), id: 1 };
  await start(releaseCard);
  await page.locator('.touch-drag-ghost').waitFor();
  const lastArrow = { ...await point(page.getByRole('button', { name: 'Next week', exact: true })), id: 2 };
  await multi('touchStart', [held, lastArrow]);
  await multi('touchEnd', [held]);
  assert.equal(await page.locator('.touch-drag-ghost').count(), 0);
  await multi('touchEnd', [lastArrow]);
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.meal-cell').first().getAttribute('data-date'), firstDate);
  // Mouse dragging retains its existing library-copy and calendar-move behavior.
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const mousePage = await desktop.newPage();
  await mousePage.goto(origin);
  const mouseDestination = mousePage.locator('.meal-cell').first();
  await mousePage.getByRole('button', { name: 'Plan Gesture dinner', exact: true }).dragTo(mouseDestination);
  await mousePage.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 5);
  const mouseCard = mousePage.locator('.meal-chip[role=button]').first();
  const mouseId = await mouseCard.getAttribute('data-card-id');
  const mouseCell = await mouseCard.evaluate(el => el.closest('td')!.dataset.date);
  const mouseTarget = mousePage.locator(`.meal-cell:not([data-date="${mouseCell}"])`).first();
  await mouseCard.dragTo(mouseTarget);
  await mousePage.waitForFunction(({id, date}) => document.querySelector(`[data-card-id="${id}"]`)?.closest('td')?.dataset.date !== date, { id: mouseId, date: mouseCell });
  await mousePage.waitForFunction(() => document.querySelectorAll('.meal-chip[role=button]').length === 5);
  console.log('Drag smoke passed: delayed tap, tap-hold copy, hold move, mobile scroll/cancel, keyboard copy alternative, two-finger cross-week move/copy.');
} finally {
  await browser.close();
  await new Promise<void>(resolve => { server.once('exit', () => resolve()); server.kill('SIGTERM'); });
  await rm(directory, { recursive: true, force: true });
}
