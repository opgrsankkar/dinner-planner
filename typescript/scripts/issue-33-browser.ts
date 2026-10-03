// After npm run build: node --import tsx scripts/issue-33-browser.ts
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

const artifacts = process.env.FEEDBACK_ARTIFACTS ?? join(process.cwd(), '.local', 'feedback', 'issue-33');
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
    const diagnostics: unknown[] = [];
    async function snapshot(label: string) {
      diagnostics.push(await page.evaluate(label => ({
        label, time: performance.now(), scrollY,
        focus: document.activeElement?.outerHTML,
        events: (window as unknown as { libraryTouchEvents: unknown[] }).libraryTouchEvents,
        viewport: { scale: visualViewport?.scale, offsetTop: visualViewport?.offsetTop },
        rows: [...document.querySelectorAll('.folio-library-row')].map(row => ({
          id: row.getAttribute('data-meal-id'), reveal: row.getAttribute('data-reveal'),
          editing: row.classList.contains('is-editing'), name: row.querySelector('.folio-library-name')?.textContent,
          transform: getComputedStyle(row.querySelector('.folio-library-surface')!).transform,
          animations: row.querySelector('.folio-library-surface')!.getAnimations().length,
          focusVisible: row.matches(':focus-visible'),
          pointerEvents: getComputedStyle(row.querySelector('.folio-library-surface')!).pointerEvents,
          rect: row.getBoundingClientRect().toJSON(),
        })),
      }), label));
    }
    async function rowMeasurements(label: string) {
      const measurements = await page.locator('.folio-library-row').evaluateAll(items => items.map(row => ({
        id: row.getAttribute('data-meal-id'),
        height: row.getBoundingClientRect().height,
        name: row.querySelector('.folio-library-name')?.getBoundingClientRect().height ?? null,
        actionTarget: row.querySelector('.folio-library-remove')?.getBoundingClientRect().toJSON() ?? null,
      })));
      await writeFile(join(artifacts, `row-heights-${label}-${width}-${theme}.json`), JSON.stringify({
        viewport: { width, height: 900 }, theme, medianRowHeight: measurements[Math.floor(measurements.length / 2)]?.height,
        rows: measurements,
      }, null, 2));
      return measurements;
    }
    await page.addInitScript(() => {
      const events: unknown[] = [];
      Object.assign(window, { libraryTouchEvents: events });
      for (const type of ['scroll', 'scrollend', 'touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'focusin'])
        document.addEventListener(type, event => {
          const target = event.target instanceof Element ? event.target : document.documentElement;
          if (!['scroll', 'scrollend', 'mousedown', 'mouseup', 'click'].includes(type) && !target.closest('.folio-library')) return;
          events.push({ type, time: performance.now(), trusted: event.isTrusted,
            scrollY, defaultPrevented: event.defaultPrevented, action: target.closest('button')?.getAttribute('aria-label'),
            target: target.outerHTML.slice(0, 500), id: target.closest('[data-meal-id]')?.getAttribute('data-meal-id') });
        }, true);
    });
    try {
    await page.goto(origin); await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Clicking submits asynchronously; fixture mutations require the authenticated board.
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    if (width === 1280 && theme === 'light') await page.evaluate(async () => {
      const response = await fetch('/api/board');
      if (!response.ok) throw new Error(`Fixture board failed: ${response.status}`);
      const board = await response.json();
      for (let i = 0; i < 12; i++) {
        const response = await fetch('/api/library', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': board.csrf }, body: JSON.stringify({ name: `Scroll test meal ${i}` }) });
        if (!response.ok) throw new Error(`Synthetic fixture setup failed: ${response.status} ${await response.text()}`);
      }
    });
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Meal library', exact: true }).click();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const library = page.locator('.folio-library'), rows = library.locator('.folio-library-row'), first = rows.first();
    if (process.env.ISSUE_34_BASELINE === '1') await page.addStyleTag({ content: `
      .folio-library .folio-library-surface { min-height: 98px; padding: 27px 0; }
      .folio-library .folio-library-name { font-size: 23px; line-height: normal; }
      .folio-library .folio-library-swipe-action { width: 56px; height: 56px; min-width: 0; min-height: 0; padding: 15px; }
      .folio-library .folio-library-row:is(:focus-visible, :has(button:focus-visible)):not(.is-editing) .folio-library-surface,
      .folio-library .folio-library-row:hover:not(.is-editing) .folio-library-surface { padding-left: 64px; padding-right: 64px; }
    `});
    await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => el.getAnimations().length)).toBeGreaterThan(0);
    const frames = await first.locator('.folio-library-surface').evaluate(el => (el.getAnimations()[0].effect as KeyframeEffect).getKeyframes());
    assert.ok(frames.some(f => f.transform === 'translateX(-48px)') && frames.some(f => f.transform === 'translateX(48px)'));
    await page.waitForTimeout(2300);
    assert.equal(await first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
    await page.mouse.move(1, 1);
    await rowMeasurements('before');
    await page.screenshot({ path: join(artifacts, `issue-34-before-${width}-${theme}.png`), fullPage: true });
    if (process.env.ISSUE_34_BASELINE === '1') await page.locator('style').last().evaluate(style => style.remove());
    await rowMeasurements('after');
    await page.screenshot({ path: join(artifacts, `issue-34-after-${width}-${theme}.png`), fullPage: true });
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
      await page.mouse.move(1, 1);
      await swipe(-80); await expect(first).toHaveAttribute('data-reveal', 'delete');
      await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, -48, 0)');
      await page.screenshot({ path: join(artifacts, `swipe-delete-${theme}.png`) });
      await swipe(80); await expect(first).toHaveAttribute('data-reveal', 'edit');
      await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 48, 0)');
      await page.screenshot({ path: join(artifacts, `swipe-edit-${theme}.png`) });
      for (const [dx, dy, cancel] of [[20, 0, false], [-80, 0, true]] as const) {
        await swipe(dx, dy, cancel); await expect(first).toHaveAttribute('data-reveal', 'closed');
      }
      await first.scrollIntoViewIfNeeded();
      const scrollBefore = await page.evaluate(() => scrollY);
      await swipe(10, -90); await expect(first).toHaveAttribute('data-reveal', 'closed');
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollBefore);
      assert.equal(mutations, 0); await swipe(80);
      await expect.poll(() => first.locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 48, 0)');
      await snapshot('before Edit tap');
      const edit = first.getByRole('button', { name: `Edit ${name}`, exact: true });
      await expect(edit).toBeVisible();
      const box = (await edit.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), { x, y }), `Edit ${name}`);
      await edit.tap();
      await snapshot('after Edit tap');
      await expect.poll(() => page.evaluate(name => (window as unknown as {
        libraryTouchEvents: { type: string; trusted: boolean; action: string }[];
      }).libraryTouchEvents.some(event => event.type === 'click' && event.trusted && event.action === `Edit ${name}`), name)).toBe(true);
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
    // Hold the real rename request while another row is edited. Saving is local
    // to the first row; a polling refresh must not discard the second draft.
    let releaseRename!: () => void;
    const renameGate = new Promise<void>(resolve => { releaseRename = resolve; });
    await page.route('**/api/library/rename', async route => { await renameGate; await route.continue(); });
    try {
      const request = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/library/rename'));
      await draft.fill(`  ${renamed}  `); await draft.press('Enter'); await request;
      await expect(draft).toBeDisabled();
      const otherId = await rows.nth(1).getAttribute('data-meal-id');
      const other = library.locator(`[data-meal-id="${otherId}"]`);
      await other.getByRole('button', { name: /^Edit / }).focus(); await page.keyboard.press('Enter');
      const otherDraft = other.getByRole('textbox'); await expect(otherDraft).toBeEnabled();
      await otherDraft.fill('Unsaved second row');
      releaseRename(); await expect(first.locator('.folio-library-name')).toHaveText(renamed);
      await expect(otherDraft).toBeEnabled(); await expect(otherDraft).toHaveValue('Unsaved second row');
      await otherDraft.press('Escape'); await expect(otherDraft).toHaveCount(0);
    } finally { releaseRename(); await page.unroute('**/api/library/rename'); }
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
    await expect(library.locator('.folio-library-hint')).toHaveCount(0);
    await expect(library).not.toContainText('Swipe right to edit, left to delete.');
    await expect(rows.first()).toHaveAttribute('aria-label', /Swipe right to edit, left to delete\. Use Tab for actions\./);
    assert.equal(await rows.first().locator('.folio-library-surface').evaluate(el => el.getAnimations().length), 0);
    assert.equal(await rows.first().locator('.folio-library-surface').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(artifacts, `settings-${width}-${theme}-reduced.png`), fullPage: true }); assert.deepEqual(errors, []);
    console.log(`PASS ${width}/${theme}: intro, explicit actions, keyboard/confirmation, rename reload identity polling/reorder, row-local pending save, add/error drafts, reduced motion, no overflow${width < 500 ? ', CDP touch left/right/short/cancel/vertical' : ', hover'}`);
    await writeFile(join(artifacts, `diagnostics-${width}-${theme}.json`), JSON.stringify({ snapshots: diagnostics, events: await page.evaluate(() => (window as unknown as { libraryTouchEvents: unknown[] }).libraryTouchEvents) }, null, 2));
    } catch (error) {
      await snapshot('failure');
      await page.screenshot({ path: join(artifacts, `failure-${width}-${theme}.png`), fullPage: true });
      await writeFile(join(artifacts, `failure-${width}-${theme}.json`), JSON.stringify({ error: String(error), snapshots: diagnostics, events: await page.evaluate(() => (window as unknown as { libraryTouchEvents: unknown[] }).libraryTouchEvents) }, null, 2));
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
  await writeFile(join(artifacts, 'server.log'), logs); await rm(directory, { recursive: true, force: true });
}
