// After npm run build: node --import tsx scripts/folio-inputs-smoke.ts
// Uses only an isolated synthetic DB and fake Todoist.
import { chromium, type Locator } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'folio-inputs-'));
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

interface InputStyle {
  color: string; underline: string; outline: string; borders: string[];
  shadow: string; transform: string; transitionProperty: string; transitionDuration: string;
}
interface Trace { duration: number; samples: (InputStyle & { time: number })[]; final: InputStyle }
declare global {
  interface Window {
    folioInputSmoke: {
      read(field: Element): InputStyle;
      settle(field: Element): Promise<InputStyle>;
      arm(field: Element, event: string, property: string): void;
      result(field: Element): Promise<Trace>;
      untilTime(field: Element, time: number): Promise<void>;
    };
  }
}
async function installHelper(page: import('@playwright/test').Page) {
  await page.addScriptTag({ path: join(process.cwd(), 'scripts/folio-inputs-browser.js') });
}
async function checkFocus(field: Locator, page: import('@playwright/test').Page, reduced: boolean) {
  await field.evaluate(el => (el as HTMLElement).blur());
  const baseline = await field.evaluate(el => window.folioInputSmoke.settle(el));
  assert.equal(baseline.underline, '0% 3px, 100% 1px');
  // Time inputs have multiple native keyboard segments. Leave the whole input
  // before tabbing back in, rather than assuming one Shift+Tab leaves the field.
  await field.focus();
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press('Shift+Tab');
    if (await field.evaluate(el => document.activeElement !== el)) break;
  }
  assert.ok(await field.evaluate(el => document.activeElement !== el), 'Keyboard leaves entire input before focus check');
  const beforeTab = await field.evaluate(el => window.folioInputSmoke.settle(el));
  assert.equal(beforeTab.underline, baseline.underline, 'Unfocused underline settles before keyboard entry');
  await field.evaluate(el => window.folioInputSmoke.arm(el, 'focus', 'backgroundSize'));
  await page.keyboard.press('Tab');
  const focus = await field.evaluate(el => window.folioInputSmoke.result(el));
  assert.ok(await field.evaluate(el => el.matches(':focus-visible')), 'Keyboard reaches field');
  assert.equal(focus.duration, reduced ? 120 : 240, 'Actual underline transition duration');
  assert.ok(focus.samples.some(sample => sample.time > 0 && sample.time < focus.duration &&
    sample.underline !== baseline.underline && sample.underline !== focus.final.underline), 'Intermediate focus underline');
  assert.equal(focus.final.underline, '100% 3px, 100% 1px');
  assert.equal(focus.final.outline, 'none');
  assert.deepEqual(focus.final.borders, ['0px', '0px', '0px', '0px']);
  assert.equal(focus.final.shadow, 'none');
  await field.evaluate(el => window.folioInputSmoke.arm(el, 'blur', 'backgroundSize'));
  await field.evaluate(el => (el as HTMLElement).blur());
  const blur = await field.evaluate(el => window.folioInputSmoke.result(el));
  assert.equal(blur.duration, reduced ? 120 : 240);
  assert.ok(blur.samples.some(sample => sample.time > 0 && sample.time < blur.duration &&
    sample.underline !== baseline.underline && sample.underline !== focus.final.underline), 'Intermediate blur underline');
  assert.equal(blur.final.underline, baseline.underline);
}
function checkRed(trace: Trace, ink: string, theme: string, reduced: boolean) {
  const red = theme === 'dark' ? 'rgb(255, 140, 156)' : 'rgb(180, 35, 53)';
  assert.equal(trace.duration, reduced ? 240 : 600);
  assert.ok(trace.samples.some(sample => sample.color === red), 'Exact red is rendered before fading');
  if (reduced) {
    assert.ok(trace.samples.some(sample => sample.time > 0 && sample.time < 40 && sample.color === red), 'Reduced motion renders the red cue before fading');
    assert.ok(trace.samples.every(sample => sample.transform === 'none'), 'Reduced motion never wiggles');
  }
  else {
    const hold = trace.samples.filter(sample => sample.time >= 40 && sample.time < 290);
    assert.ok(hold.length >= 2, 'Observe hold during wiggle');
    assert.ok(hold.every(sample => sample.color === red), 'Red holds throughout wiggle');
    assert.ok(hold.some(sample => sample.transform !== 'none' && sample.transform !== 'matrix(1, 0, 0, 1, 0, 0)'), 'Wiggle visibly moves');
  }
  const fade = trace.samples.filter(sample => sample.time > (reduced ? 40 : 300) && sample.time < trace.duration);
  const colors = new Set(fade.filter(sample => sample.color !== red && sample.color !== ink).map(sample => sample.color));
  assert.ok(colors.size >= 2, 'Multiple intermediate red fade colors');
  assert.equal(trace.final.color, ink, 'Untouched empty field returns fully to baseline');
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Meal library' }).waitFor();
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/library') writes++; });
  for (const theme of ['light', 'dark']) {
    for (const reduced of [false, true]) {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.goto(origin);
      await installHelper(page);
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await checkFocus(page.getByRole('searchbox', { name: 'Search or type a meal name', exact: true }), page, reduced);
      await page.goto(`${origin}/settings`);
      await installHelper(page);
      await page.getByRole('button', { name: 'Meal library', exact: true }).click();
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const field = page.getByRole('searchbox', { name: 'Search meals', exact: true });
      await checkFocus(field, page, reduced);
      const ink = await field.evaluate(el => window.folioInputSmoke.read(el).color);
      const add = page.getByRole('button', { name: '＋ Add Meal', exact: true });
      for (let repeat = 0; repeat < 2; repeat++) {
        await field.evaluate(el => window.folioInputSmoke.arm(el, 'submit', 'color'));
        await add.click();
        checkRed(await field.evaluate(el => window.folioInputSmoke.result(el)), ink, theme, reduced);
        assert.equal(await field.inputValue(), '', 'Fade completes untouched and empty');
        assert.equal(await field.getAttribute('aria-invalid'), 'true', 'Semantics survive visual feedback');
      }
      // Restart during active feedback, then verify the entire new hold/fade.
      await add.click();
      await field.evaluate(el => window.folioInputSmoke.untilTime(el, 80));
      await field.evaluate(el => window.folioInputSmoke.arm(el, 'submit', 'color'));
      await add.click();
      checkRed(await field.evaluate(el => window.folioInputSmoke.result(el)), ink, theme, reduced);
      await add.click();
      await field.evaluate(el => window.folioInputSmoke.untilTime(el, 80));
      await field.fill('Synthetic typing');
      assert.equal(await field.getAttribute('aria-invalid'), 'false');
      const typed = await field.evaluate(el => window.folioInputSmoke.settle(el));
      assert.equal(typed.color, ink, 'Typing smoothly resets feedback');
      assert.equal(typed.transform, 'none', 'Typing cancels wiggle');
      await field.fill('');
      assert.equal(await page.locator('.folio-library-feedback').innerText(), '');
      await field.focus(); await page.keyboard.press('Tab');
      assert.ok(await add.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none'), 'Button keeps keyboard outline');
      await page.getByRole('button', { name: 'Meal slots', exact: true }).click();
      await checkFocus(page.getByLabel('Slot label 1', { exact: true }), page, reduced);
      await checkFocus(page.getByLabel('Slot time 1', { exact: true }), page, reduced);
      console.log(`Passed ${theme}/${reduced ? 'reduced' : 'normal'}: red feedback and keyboard underlines`);
    }
  }
  assert.equal(writes, 0, 'Empty submits and typing never send library requests');
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
  await rm(directory, { recursive: true, force: true });
}
