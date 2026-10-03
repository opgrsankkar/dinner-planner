// Run after npm run build. Uses only an isolated synthetic DB and fake Todoist.
// Responsive viewports 375/390/1280 use desktop keyboard time segments; separate
// 375/390 mobile touch contexts cover picker controls and skip only partial typing.
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
async function checkSlotRowLayout(page: Page) {
  const rows = page.locator('.slot-edit-row');
  assert.equal(await page.locator('.folio-slot-number').count(), 0, 'Meal slot rows have no visible numeric prefix');
  for (const row of await rows.all()) {
    const name = row.locator('.slot-name');
    const time = row.locator('.slot-time');
    const remove = row.locator('.remove-slot');
    const [rowGrid, nameBox, timeBox, removeBox] = await Promise.all([
      row.locator('.slot-edit-row-content').evaluate(el => getComputedStyle(el).gridTemplateColumns),
      name.boundingBox(), time.boundingBox(), remove.boundingBox(),
    ]);
    assert.ok(rowGrid && rowGrid.split(' ').length === 2, `Name and time use two tracks: ${rowGrid}`);
    assert.equal(await page.locator('.folio-slot-head').count(), 0, 'Visible headings remain removed');
    assert.ok(nameBox && timeBox && removeBox, 'All row controls remain visible');
    assert.ok(removeBox.width >= 44 && removeBox.height >= 44, 'Remove target is at least 44px in both dimensions');
    assert.ok(nameBox.x + nameBox.width <= timeBox.x + 2, 'Name and time do not overlap');
    assert.ok(timeBox.x + timeBox.width <= removeBox.x + 2, 'Time and delete do not overlap');
    assert.ok(
      Math.abs(nameBox.y + nameBox.height - timeBox.y - timeBox.height) <= 1,
      'Name and time underlines align within one CSS pixel',
    );
  }
  assert.equal(await page.getByLabel('Slot label 1', { exact: true }).count(), 1, 'Accessible name label remains');
  assert.equal(await page.getByLabel('Slot time 1', { exact: true }).count(), 1, 'Accessible time label remains');
}
async function touchSequence(page: Page, points: { type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'; x: number; y: number }[]) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    for (const [index, { type, x, y }] of points.entries()) {
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }],
      });
      if (index + 1 < points.length) await page.waitForTimeout(40);
    }
  } finally {
    await cdp.detach();
  }
}
async function swipeRow(page: Page, row: import('@playwright/test').Locator, direction: 'left' | 'right' = 'left') {
  const box = await row.boundingBox();
  assert.ok(box, 'Swipe row is visible');
  const x = direction === 'left' ? box.x + box.width - 22 : box.x + 22;
  const delta = direction === 'left' ? -1 : 1;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + delta * 45, y, id: 1 }] });
    await page.waitForTimeout(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + delta * 104, y, id: 1 }] });
    await page.waitForTimeout(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  return row.evaluate(el => el.classList.contains('is-revealed'));
}
async function removeDraft(page: Page, row: import('@playwright/test').Locator, mobile: boolean) {
  const slotId = await row.getAttribute('data-slot-id');
  assert.ok(slotId, 'Remove target has a stable slot ID');
  const remove = row.locator('.remove-slot');
  if (mobile) {
    assert.equal(await swipeRow(page, row), true, 'Touch swipe reveals the remove action');
    await page.waitForTimeout(220);
  }
  else {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await row.hover();
    await page.waitForTimeout(200);
    const state = await remove.evaluate(el => ({ opacity: getComputedStyle(el).opacity, pointerEvents: getComputedStyle(el).pointerEvents, disabled: (el as HTMLButtonElement).disabled, row: el.parentElement?.className, hover: el.parentElement?.matches(':hover'), focusWithin: el.parentElement?.matches(':focus-within'), hoverMedia: matchMedia('(hover:hover)').matches, finePointer: matchMedia('(pointer:fine)').matches }));
    assert.equal(state.opacity, '1', `Desktop hover reveals delete: ${JSON.stringify(state)}`);
  }
  const hitTest = await remove.evaluate(el => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { hit: hit?.className?.toString(), matches: hit === el || el.contains(hit), disabled: (el as HTMLButtonElement).disabled };
  });
  assert.equal(hitTest.matches, true, `Remove button receives pointer: ${JSON.stringify(hitTest)}`);
  await remove.click();
  await page.locator(`[data-slot-id="${slotId}"]`).waitFor({ state: 'detached' });
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
  for (const { width, mobile } of [
    { width: 375, mobile: true }, { width: 390, mobile: true },
    { width: 375, mobile: false }, { width: 390, mobile: false }, { width: 1280, mobile: false },
  ]) {
    const label = `${width}${mobile ? "-mobile" : ""}`;
    const setup = await browser.newContext();
    const login = await setup.newPage();
    await login.goto(origin);
    await login.getByLabel('Password', { exact: true }).fill(password);
    await login.getByRole('button', { name: 'Sign in', exact: true }).click();
    await login.getByRole('complementary', { name: 'Meal library', exact: true }).waitFor();
    await login.locator('.meal-grid').waitFor();
    const snapshot = await (await setup.request.get(`${origin}/api/board`)).json();
    const seeded = snapshot.slots.map((slot: { id: string }, index: number) => ({ id: slot.id, name: ['Breakfast', 'Lunch', 'Dinner'][index], time: ['08:00', '13:00', '19:00'][index] }));
    const response = await setup.request.post(`${origin}/api/settings/slots`, { headers: { 'X-CSRF-Token': snapshot.csrf, Origin: origin }, data: { slots: seeded, revision: snapshot.settings.revision } });
    assert.ok(response.ok(), await response.text());
    const storageState = await setup.storageState();
    await setup.close();
    const viewport = { width, height: width < 700 ? 844 : 900 };
    // Use desktop native time segments at every responsive viewport: touch
    // emulation substitutes a picker-only control that cannot be partially typed.
    const context: BrowserContext = await browser.newContext({ storageState, viewport, isMobile: mobile, hasTouch: mobile, recordVideo: { dir: output, size: viewport } });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/settings`);
    await openSlots(page);
    assert.equal(await page.getByText(/^(Name|Time)$/).count(), 0, 'No Name or Time heading above the slot inputs');
    assert.ok(await page.getByLabel('Slot label 1', { exact: true }).isVisible(), 'Slot name keeps its accessible field label');
    assert.ok(await page.getByLabel('Slot time 1', { exact: true }).isVisible(), 'Slot time keeps its accessible field label');
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isDisabled(), 'Revert is disabled when slots match the saved baseline');
    await checkSlotRowLayout(page);
    await page.mouse.move(1, 1);
    if (!mobile && await page.locator('.slot-intro-peek').count()) {
      await page.waitForTimeout(700);
      const peek = await page.locator('.slot-edit-row:nth-child(2) .slot-edit-row-content').evaluate(el => ({
        name: getComputedStyle(el).animationName,
        transform: getComputedStyle(el).transform,
      }));
      assert.equal(peek.name, 'slot-delete-peek', 'Second row runs a one-time left-peek introduction');
      assert.match(peek.transform, /^matrix\(/, 'Intro animates the row content and reveals its red action behind it');
    }
    assert.equal(await page.locator('.slot-time').first().getAttribute('type'), 'time', 'Native time input remains enabled');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const focus of ['unfocused', 'focused']) {
        if (focus === 'focused') await page.locator('.slot-time').first().focus();
        else await page.locator('.slot-time').first().evaluate(input => input.blur());
        await page.waitForTimeout(250);
        await checkSlotRowLayout(page);
        await page.screenshot({ path: join(output, `slots-${label}-${theme}-${focus}.png`), fullPage: true });
      }
      if (mobile) {
        const sample = page.locator('.slot-edit-row').first();
        await sample.evaluate(el => el.scrollIntoView({ block: 'center' }));
        const box = await sample.boundingBox();
        assert.ok(box, 'First row is visible for touch checks');
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await touchSequence(page, [{ type: 'touchStart', x, y }, { type: 'touchEnd', x, y }]);
        assert.equal(await sample.evaluate(el => el.classList.contains('is-revealed')), false, 'Short touch does not reveal delete');
        await touchSequence(page, [{ type: 'touchStart', x, y }, { type: 'touchMove', x: x - 65, y }, { type: 'touchCancel', x: x - 65, y }]);
        assert.equal(await sample.evaluate(el => el.classList.contains('is-revealed')), false, 'Canceled swipe resets the row');
        await sample.evaluate(el => {
          (window as Window & { issue30VerticalLog?: unknown[] }).issue30VerticalLog = [];
          for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
            el.addEventListener(type, event => (window as Window & { issue30VerticalLog?: unknown[] }).issue30VerticalLog?.push({ type, x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY, pointerType: (event as PointerEvent).pointerType }));
          }
        });
        await touchSequence(page, [{ type: 'touchStart', x, y }, { type: 'touchMove', x, y: y + 80 }, { type: 'touchEnd', x, y: y + 80 }]);
        assert.equal(await sample.evaluate(el => el.classList.contains('is-revealed')), false, 'Vertical touch scroll does not reveal delete');
        const verticalState = await page.evaluate(() => ({
          touchAction: getComputedStyle(document.querySelector('.slot-edit-row')!).touchAction,
          events: (window as Window & { issue30VerticalLog?: { type: string }[] }).issue30VerticalLog,
          scrollY: window.scrollY,
        }));
        assert.equal(verticalState.touchAction, 'pan-y', 'Vertical touch movement remains available to native scrolling');
        assert.ok(verticalState.events?.some(event => event.type === 'pointercancel'), `Vertical motion cancels the row gesture: ${JSON.stringify(verticalState)}`);
        const lunchRow = page.locator(`[data-slot-id="${seeded[1].id}"]`);
        assert.equal(await swipeRow(page, lunchRow), true, 'A deliberate left swipe reveals delete');
        assert.equal(await swipeRow(page, lunchRow, 'right'), false, 'A right swipe closes the revealed action');
        await page.waitForTimeout(220);
        assert.equal(await swipeRow(page, lunchRow), true, 'A second left swipe reveals delete again');
        await page.waitForTimeout(200);
        await checkSlotRowLayout(page);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
          await page.waitForTimeout(120);
          await page.screenshot({ path: join(output, `slots-${label}-swipe-${theme}.png`), fullPage: true });
        }
        await lunchRow.locator('.remove-slot').click();
        await lunchRow.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Revert', exact: true }).click();
        await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
      }
    }
    if (!mobile) {
      while (await page.locator('.slot-edit-row').count() > 1) {
        await removeDraft(page, page.locator('.slot-edit-row').last(), mobile);
      }
      assert.equal(await page.locator('.remove-slot').isDisabled(), true, 'The final meal slot cannot be removed');
      await page.getByRole('button', { name: 'Revert', exact: true }).click();
      await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    }
    if (!mobile) {
      const lunchName = page.locator(`[data-slot-id="${seeded[1].id}"] .slot-name`);
      await lunchName.focus();
      const removeButton = page.locator(`[data-slot-id="${seeded[1].id}"] .remove-slot`);
      await removeButton.waitFor();
      for (let attempt = 0; attempt < 6; attempt++) {
        if (await removeButton.evaluate(el => document.activeElement === el)) break;
        await page.keyboard.press('Tab');
      }
      assert.equal(await removeButton.evaluate(el => document.activeElement === el && el.matches(':focus-visible')), true, 'Keyboard focus reaches the remove button');
      await page.waitForTimeout(200);
      assert.equal(await removeButton.evaluate(el => getComputedStyle(el).opacity), '1', `Delete action appears on keyboard focus (${await removeButton.evaluate(el => JSON.stringify({ disabled: (el as HTMLButtonElement).disabled, focusVisible: el.matches(':focus-visible'), row: el.parentElement?.className, opacity: getComputedStyle(el).opacity }))})`);
      await lunchName.focus();
    }
    await page.waitForTimeout(500);
    const actionBoxes = await Promise.all(['+ Add slot', 'Save', 'Revert'].map(name => page.getByRole('button', { name, exact: true }).boundingBox()));
    assert.ok(actionBoxes.every(box => box && Math.abs(box.y - actionBoxes[0]!.y) < 3), 'All actions on one line');
    assert.equal(await page.locator('.slot-order-controls, .slot-edit-grip, [data-hint]').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^Move .* (up|down)$/ }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    const breakfastId = seeded[0].id;
    const breakfast = page.locator(`[data-slot-id="${breakfastId}"]`);
    const lunch = page.locator(`[data-slot-id="${seeded[1].id}"]`);
    await page.screenshot({ path: join(output, `slots-${label}.png`), fullPage: true });
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
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isEnabled(), 'Revert is enabled with an unsaved time edit');
    await page.waitForTimeout(950);
    assert.ok(await page.evaluate(() => (window as unknown as { slotSamples: string[] }).slotSamples.some(value => /translate/.test(value) && !/translateY\(0px\)/.test(value))), 'Time edit visibly animates row movement');
    assert.equal(await breakfast.locator('.slot-time').inputValue(), '20:00', 'Stable ID keeps edited value');
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isDisabled(), 'Revert is disabled after restoring the saved baseline');
    await breakfast.locator('.slot-time').fill('13:00');
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Duplicate time invalid');
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    if (!mobile) {
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
    } else {
      // Mobile Chromium exposes a picker without keyboard hour/minute segments.
      // Home/Backspace cannot create a partial value; all other checks still run.
      console.log(`SKIP ${label}px native keyboard partial: mobile picker has no editable segments`);
    }
    await page.getByRole('button', { name: '+ Add slot', exact: true }).click();
    const addedId = await page.locator('.slot-edit-row').first().getAttribute('data-slot-id');
    const added = page.locator(`[data-slot-id="${addedId}"]`);
    assert.equal(await added.locator('.slot-name').inputValue(), '', 'New draft is inserted at the top');
    await added.locator('.slot-name').fill('Snack');
    await added.locator('.slot-time').fill('16:00');
    await checkOrder(page, ['Snack', 'Breakfast', 'Lunch', 'Dinner']);
    await removeDraft(page, added, mobile);
    await checkOrder(page, ['Breakfast', 'Lunch', 'Dinner']);
    assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Remove added slot restores clean baseline');
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isDisabled(), 'Revert is disabled after adding then removing a slot');
    await breakfast.locator('.slot-time').fill('20:00');
    await page.getByRole('button', { name: '+ Add slot', exact: true }).click();
    const snackId = await page.locator('.slot-edit-row').first().getAttribute('data-slot-id');
    const snack = page.locator(`[data-slot-id="${snackId}"]`);
    await snack.locator('.slot-name').fill('Snack');
    await snack.locator('.slot-time').fill('16:00');
    await page.getByRole('button', { name: '+ Add slot', exact: true }).click();
    const supperId = await page.locator('.slot-edit-row').first().getAttribute('data-slot-id');
    const supper = page.locator(`[data-slot-id="${supperId}"]`);
    await supper.locator('.slot-name').fill('Supper');
    await supper.locator('.slot-time').fill('18:00');
    await checkOrder(page, ['Supper', 'Snack', 'Lunch', 'Dinner', 'Breakfast']);
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isEnabled(), 'Revert is enabled before saving an edit');
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
    await page.screenshot({ path: join(output, `slots-${label}-retry.png`), fullPage: true });
    await page.evaluate(`
      window.saveSlotSamples = [];
      const until = performance.now() + 900;
      function sample() {
        document.querySelectorAll('.slot-edit-row').forEach(row => window.saveSlotSamples.push(row.style.transform));
        if (performance.now() < until) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    `);
    await page.getByRole('button', { name: 'Save failed', exact: true }).click();
    await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
    await checkOrder(page, ['Lunch', 'Snack', 'Supper', 'Dinner', 'Breakfast']);
    await page.waitForTimeout(950);
    assert.ok(await page.evaluate(() => (window as unknown as { saveSlotSamples: string[] }).saveSlotSamples.some(value => /translate/.test(value) && !/translateY\(0px\)/.test(value))), 'Saving moves drafts chronologically with the existing layout animation');
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isDisabled(), 'Revert is disabled after save updates the baseline');
    await page.waitForTimeout(1100);
    await page.reload(); await openSlots(page);
    await checkOrder(page, ['Lunch', 'Snack', 'Supper', 'Dinner', 'Breakfast']);
    assert.ok(await page.getByRole('button', { name: 'Revert', exact: true }).isDisabled(), 'Revert is disabled after reload of saved slots');
    const persisted = await (await context.request.get(`${origin}/api/board`)).json();
    assert.deepEqual(persisted.slots.map((slot: { name: string }) => slot.name), ['Lunch', 'Snack', 'Supper', 'Dinner', 'Breakfast']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload(); await openSlots(page);
    assert.equal(await page.locator('.slot-intro-peek').count(), 0, 'Reduced motion skips the introductory peek');
    await breakfast.locator('.slot-time').fill('06:00');
    await checkOrder(page, ['Breakfast', 'Lunch', 'Snack', 'Supper', 'Dinner']);
    assert.ok(await page.locator('.slot-edit-row').evaluateAll(rows => rows.every(row => !((row as HTMLElement).style.transform) || (row as HTMLElement).style.transform === 'none')), 'Reduced motion uses immediate layout');
    await page.screenshot({ path: join(output, `slots-${label}-reduced.png`), fullPage: true });
    await page.getByRole('button', { name: 'Revert', exact: true }).click();
    await checkOrder(page, ['Lunch', 'Snack', 'Supper', 'Dinner', 'Breakfast']);
    // Each viewport reuses this synthetic database; remove test-only rows so
    // the next context starts with the same three-slot fixture.
    await removeDraft(page, page.locator(`[data-slot-id="${snackId}"]`), mobile);
    await removeDraft(page, page.locator(`[data-slot-id="${supperId}"]`), mobile);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
    await checkOrder(page, ['Lunch', 'Dinner', 'Breakfast']);
    assert.deepEqual(errors, []);
    const video = page.video()!;
    await context.close();
    const destination = join(output, `slots-${label}-chronological.webm`);
    await rename(await video.path(), destination);
    console.log(`PASS ${label}px: chronological animation, equal times${mobile ? "" : ", native keyboard partial freeze"}, add/remove, revert, save/retry/reload, reduced motion; ${destination}`);
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
  await rm(directory, { recursive: true, force: true });
}
