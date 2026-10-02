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

const artifacts = join(process.cwd(), '.local', 'issues-library');
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
  for (const width of [1280, 375, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, isMobile: width < 500 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const library = page.getByRole('complementary', { name: 'Meal library' });
    await library.waitFor();
    const field = library.getByRole('searchbox');
    const add = library.getByRole('button', { name: 'Add meal', exact: true });
    await expect(add).toBeEnabled();
    const ink = await field.evaluate(el => getComputedStyle(el).color);
    // Submit and capture in one browser task, before protocol latency can miss
    // the red hold. Render intermediate wiggle frames by seeking the actual
    // animation so CPU load cannot skip every visible movement frame.
    const cue = await field.evaluate(async el => {
      (el.closest('form')!.querySelector('button[type=submit]') as HTMLButtonElement).click();
      const animations = el.getAnimations();
      const keyframes = animations.map(animation => animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []);
      const initialColor = getComputedStyle(el).color;
      const wiggle = animations.find(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.transform !== undefined));
      const transforms: string[] = [];
      if (wiggle) {
        wiggle.pause();
        const duration = Number(wiggle.effect!.getTiming().duration);
        for (const fraction of [.25, .5, .75]) {
          wiggle.currentTime = duration * fraction;
          transforms.push(getComputedStyle(el).transform);
        }
        wiggle.currentTime = 0;
        wiggle.play();
      }
      await Promise.all(animations.map(animation => animation.finished));
      await new Promise(resolve => requestAnimationFrame(resolve));
      return { keyframes, initialColor, transforms, finalColor: getComputedStyle(el).color, finalTransform: getComputedStyle(el).transform };
    });
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    assert.equal(cue.initialColor, 'rgb(180, 35, 53)', 'Empty Add renders red immediately');
    assert.ok(cue.keyframes.some(frames => frames.some(frame => frame.color === '#b42335' || frame.color === 'rgb(180, 35, 53)')), 'Empty Add has red animation keyframe');
    assert.ok(cue.keyframes.some(frames => frames.some(frame => frame.transform === 'translateX(-4px)')
      && frames.some(frame => frame.transform === 'translateX(4px)')), 'Empty Add has both wiggle directions');
    assert.ok(cue.transforms.length === 3 && cue.transforms.every(transform => transform !== 'none' && transform !== 'matrix(1, 0, 0, 1, 0, 0)'), 'Empty Add renders actual intermediate wiggle frames');
    assert.equal(cue.finalColor, ink, 'Red resets untouched after animation finishes');
    assert.equal(cue.finalTransform, 'none', 'Wiggle resets after animation finishes');
    await add.click(); await page.waitForTimeout(50); await add.click();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await field.fill('Typing resets active feedback');
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await page.waitForTimeout(250);
    assert.equal(await field.evaluate(el => getComputedStyle(el).color), ink, 'Typing restores ink');
    assert.equal(await field.evaluate(el => getComputedStyle(el).transform), 'none', 'Typing cancels wiggle');
    if (width === 1280) {
      await page.emulateMedia({ reducedMotion: 'reduce' }); await field.fill('');
      // Submit and sample within one browser task: the short red cue can finish
      // before a second protocol round trip on a CPU-loaded host.
      const reduced = await field.evaluate(async el => {
        (el.closest('form')!.querySelector('button[type=submit]') as HTMLButtonElement).click();
        const frames = el.getAnimations().map(animation => animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []);
        const initial = { color: getComputedStyle(el).color, transform: getComputedStyle(el).transform };
        const animations = el.getAnimations();
        await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(resolve));
        return { frames, initial, final: { color: getComputedStyle(el).color, transform: getComputedStyle(el).transform } };
      });
      assert.equal(reduced.initial.color, 'rgb(180, 35, 53)', 'Reduced motion renders red cue');
      assert.equal(reduced.initial.transform, 'none', 'Reduced motion renders no wiggle');
      assert.ok(reduced.frames.every(frames => frames?.every(frame => frame.transform === undefined)), 'Reduced motion has no movement animation');
      assert.equal(reduced.final.color, ink, 'Reduced red resets');
      assert.equal(reduced.final.transform, 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    await field.fill(`Synthetic meal ${width}`);
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await add.click();
    await expect(field).toHaveValue('');
    await expect(library.locator('.library-feedback')).toContainText(`Added Synthetic meal ${width}`);
    await field.fill(`Synthetic meal ${width}`); await add.click();
    await expect(field).toHaveValue('');
    await expect(library.getByRole('button', { name: `Plan Synthetic meal ${width}`, exact: true })).toHaveCount(1);
    let requests = 0;
    await page.route('**/api/library', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      requests++;
      await new Promise(resolve => setTimeout(resolve, 400));
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic add failure' }) });
    });
    await field.fill('Preserve failed meal');
    await add.click();
    await expect(field).toBeDisabled();
    await page.locator('.library-add-row').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect(library.getByRole('alert')).toContainText('Synthetic add failure');
    assert.equal(requests, 1, 'Pending submit guard blocks duplicate requests');
    await expect(field).toHaveValue('Preserve failed meal');
    await expect(add).toBeEnabled();
    await field.fill(''); await page.unroute('**/api/library');
    const shuffle = library.getByRole('button', { name: 'Shuffle meal library', exact: true });
    const shuffleBox = await shuffle.boundingBox(); const svgBox = await shuffle.locator('svg').boundingBox();
    assert.ok(shuffleBox && shuffleBox.width >= 44 && shuffleBox.height >= 44);
    assert.ok(svgBox && svgBox.width >= 26 && svgBox.height >= 26);
    assert.equal(await shuffle.innerText(), '', 'Shuffle is icon only');
    const shuffleResponse = page.waitForResponse(response => response.url().endsWith('/api/library/shuffle') && response.request().method() === 'POST');
    await shuffle.click(); assert.ok((await shuffleResponse).ok());
    const cards = library.locator('.library-chip');
    assert.ok(await cards.count() > 0);
    assert.equal(await cards.locator('button,a,input,select').count(), 0, 'Cards have no nested interactive controls');
    const compact = await cards.first().boundingBox(); assert.ok(compact && compact.height < 60, 'Compact card height');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document overflow');
    const card = library.getByRole('button', { name: `Plan Synthetic meal ${width}`, exact: true });
    const dialog = page.getByRole('dialog', { name: `Plan Synthetic meal ${width}`, exact: true });
    for (const action of ['click', 'Enter', 'Space']) {
      if (action === 'click') { if (width < 500) await card.tap(); else await card.click(); }
      else { await card.focus(); await page.keyboard.press(action); }
      await expect(dialog).toBeVisible();
      const planned = page.waitForResponse(response => response.url().endsWith('/api/plan') && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Plan meal', exact: true }).click();
      assert.ok((await planned).ok(), `${action} submits a real plan request`);
      await expect(dialog).not.toBeVisible();
    }
    if (width === 1280) {
      const response = page.waitForResponse(response => response.url().endsWith('/api/plan') && response.request().method() === 'POST');
      await card.dragTo(page.locator('.meal-cell').first());
      assert.ok((await response).ok(), 'Mouse drag places meal');
      await expect(page.locator('.action-dialog')).not.toBeVisible();
      await card.evaluate(el => (el as HTMLElement).click());
      await expect(page.locator('.action-dialog')).not.toBeVisible();
      await card.click(); await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await page.screenshot({ path: join(artifacts, `library-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: shuffle, compact cards, no overflow, click/tap/Enter/Space plan, Add empty/success/duplicate/failure/pending guard${width === 1280 ? ', native drag/drop and drag click suppression' : ''}`);
    await context.close();
  }
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
  await writeFile(join(artifacts, 'server.log'), logs);
  await rm(directory, { recursive: true, force: true });
}
