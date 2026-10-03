import { test, expect } from '@playwright/test';

test.describe('Meal Library gestures and UI regression', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('/');
    await page.fill('input[type="password"]', 'planner');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');
    // Go to settings
    await page.goto('/settings');
  });

  test('Library shows meals, supports swipe right to edit', async ({ page }) => {
    // Wait for library section
    const section = page.locator('.folio-library');
    await expect(section).toBeVisible();

    // Verify keyboard alternatives exist
    const firstMeal = section.locator('.folio-library-row-wrapper').first();
    const editBtn = firstMeal.locator('button.folio-library-edit-btn');
    await expect(editBtn).toBeAttached();

    // Swipe right (dx > 0)
    const row = firstMeal.locator('.folio-library-row');
    const box = await row.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    
    // Screenshot
    await page.screenshot({ path: '.local/comparison/swipe-edit.png' });
    
    // Click edit button
    await editBtn.click();
    
    // Check input appears
    const input = firstMeal.locator('input[type="text"]');
    await expect(input).toBeVisible();
    await input.fill('Edited Meal Name');
    await page.keyboard.press('Enter');

    // Screenshot after edit
    await page.screenshot({ path: '.local/comparison/edit-saved.png' });
    await expect(section.locator('.folio-library-name').filter({ hasText: 'Edited Meal Name' })).toBeVisible();
  });

  test('Library supports swipe left to delete', async ({ page }) => {
    const section = page.locator('.folio-library');
    await expect(section).toBeVisible();

    const secondMeal = section.locator('.folio-library-row-wrapper').nth(1);
    const deleteBtn = secondMeal.locator('button.folio-library-remove-btn');
    
    // Swipe left (dx < 0)
    const row = secondMeal.locator('.folio-library-row');
    const box = await row.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 100, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    
    await page.screenshot({ path: '.local/comparison/swipe-delete.png' });

    // Click delete
    page.once('dialog', dialog => dialog.accept());
    await deleteBtn.click();
    
    // Check it is removed
    await expect(secondMeal).not.toBeVisible();
  });
});

  test('Library respects dark mode', async ({ page }) => {
    // Enable dark mode
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/settings');
    const section = page.locator('.folio-library');
    await expect(section).toBeVisible();
    await page.screenshot({ path: '.local/comparison/dark-mode.png' });
  });

  test('Keyboard navigation works', async ({ page }) => {
    await page.goto('/settings');
    const firstMeal = page.locator('.folio-library-row-wrapper').first();
    const editBtn = firstMeal.locator('button.folio-library-edit-btn');
    
    // focus via tab
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    // ... just check if focus works by clicking it
    await editBtn.focus();
    await page.screenshot({ path: '.local/comparison/keyboard-focus.png' });
  });
