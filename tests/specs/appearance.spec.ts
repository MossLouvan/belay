import { test, expect } from '@playwright/test';
import { CODE, HOST } from '../test-env';

test('Current and Fieldwork: persisted choice, controls, navigation, and phone layouts', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId('welcome-continue').click();
  await page.getByTestId('how-it-works-continue').click();
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();
  const code = page.getByTestId('code-input');
  await expect(code.or(page.getByTestId('screen-surface')).first()).toBeVisible();
  if (await code.isVisible()) { await code.fill(CODE); await page.getByTestId('pair-btn').click(); }
  await expect(page.getByTestId('screen-surface')).toBeVisible();
  for (const appearance of ['Fieldwork', 'Current']) {
    await page.getByTestId('screen-back').click();
    await page.getByTestId('choose-appearance').click();
    await page.getByTestId('appearance-picker').getByText(appearance, { exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('belay.themeMode'))).toBe(appearance.toLowerCase());
    await page.getByTestId('sheet-close').click();
    await page.screenshot({ path: `../output/design-concepts-2026-09-11/${appearance.toLowerCase()}-devices-actual.png` });
    await page.reload();
    await page.getByTestId('choose-appearance').click();
    await expect(page.getByTestId('appearance-picker').getByRole('radio', { name: appearance })).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('sheet-close').click();
    await page.getByTestId(/^device-/).first().click();
    await expect(page.getByTestId('trackpad-surface')).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: `../output/design-concepts-2026-09-11/${appearance.toLowerCase()}-screen-actual.png` });
    await page.getByTestId('toggle-type').click();
    await expect(page.getByTestId('key-Esc')).toBeVisible();
    await expect(page.getByTestId('type-input')).toBeVisible();
    await page.getByTestId('toggle-type').click();
    await expect(page.getByTestId('key-Esc')).not.toBeVisible();
    await page.getByTestId('more-controls').click();
    await page.getByTestId('right-click').click();
    await page.getByRole('button', { name: 'Next tap: right-click · Cancel' }).click();
    await page.getByTestId('nav-system').click();
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await page.getByTestId('panel-close').click();
    for (const size of [{ width: 375, height: 667 }, { width: 430, height: 932 }]) {
      await page.setViewportSize(size);
      await expect(page.getByTestId('appearance-nav')).toBeVisible();
      const audio = await page.getByTestId('quick-audio').boundingBox();
      const dock = await page.getByTestId('control-dock').boundingBox();
      expect(audio!.y + audio!.height).toBeLessThanOrEqual(dock!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  }
  expect(errors).toEqual([]);
});
