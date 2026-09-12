import { test, expect, type Page } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// Turning the phone sideways must land on PAD control with a visible way back
// to the controls. Both halves are asserted here against the real web build:
// the pointer mode after a rotation, the top-left Controls tab that brings the
// auto-hidden bar back, and the fact that neither of them steals a gesture the
// trackpad needs.

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

async function reachScreen(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId('welcome-continue').click();
  await page.getByTestId('how-it-works-continue').click();
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();
  const code = page.getByTestId('code-input');
  await expect(code.or(page.getByTestId('screen-surface')).first()).toBeVisible();
  if (await code.isVisible()) {
    await code.fill(CODE);
    await page.getByTestId('pair-btn').click();
  }
  await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 20000 });
}

async function chooseAppearance(page: Page, appearance: 'Current' | 'Fieldwork') {
  await page.getByTestId('screen-back').click();
  await page.getByTestId('choose-appearance').click();
  await page.getByTestId('appearance-picker').getByText(appearance, { exact: true }).click();
  await page.getByTestId('sheet-close').click();
  await page.getByTestId(/^device-/).first().click();
  await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 20000 });
}

/**
 * The selected segment of the pointer-mode switch. React Native Web renders
 * the switch's selection as the segment's accent FILL (the roles are
 * tablist/tab but the selected state does not reach the DOM as aria-selected),
 * so the filled segment is what "selected" means here.
 */
async function selectedMode(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ids = ['touch', 'trackpad', 'scroll'];
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="pointer-mode-${id}"]`);
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return id;
    }
    return 'none';
  });
}

/**
 * Bring the controls up and act on them. The bar auto-hides again after 4s of
 * quiet, so the reveal and the press are retried together rather than assumed
 * to fit inside one window.
 */
async function withControls(page: Page, act: () => Promise<void>) {
  await expect(async () => {
    const tab = page.getByTestId('controls-tab');
    if (await tab.count()) await tab.click({ timeout: 2000 });
    await act();
  }).toPass({ timeout: 20000 });
}

test('landscape defaults to pad, with a top-left tab that opens the controls', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await reachScreen(page);

  for (const appearance of ['Current', 'Fieldwork'] as const) {
    await page.setViewportSize(PORTRAIT);
    await chooseAppearance(page, appearance);

    // Upright: the phone is a picture you poke. Portrait keeps the mode switch
    // in the More controls sheet, so open it to read the selection.
    await page.getByTestId('more-controls').click();
    await expect.poll(() => selectedMode(page)).toBe('touch');
    await page.getByTestId('sheet-close').click();

    // --- rotate -------------------------------------------------------------
    await page.setViewportSize(LANDSCAPE);
    await expect.poll(() => selectedMode(page)).toBe('trackpad');
    // Pad mode draws the visible cursor over the picture.
    await expect(page.getByTestId('crosshair')).toBeAttached();

    // The bar auto-hides after 4s; the tab is the visible way back.
    const tab = page.getByTestId('controls-tab');
    await expect(tab).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: `../docs/screenshots/landscape-hidden-${appearance.toLowerCase()}.png` });

    // --- it stays out of the picture's way ----------------------------------
    const tabBox = (await tab.boundingBox())!;
    expect(tabBox.x).toBeLessThan(LANDSCAPE.width / 2);
    expect(tabBox.y + tabBox.height).toBeLessThan(LANDSCAPE.height / 2);
    expect(tabBox.width * tabBox.height).toBeLessThan(0.05 * LANDSCAPE.width * LANDSCAPE.height);
    // The centre of the screen — where a pad drag lives — is not the tab.
    const atCentre = await page.evaluate(([w, h]) => {
      const el = document.elementFromPoint(w / 2, h / 2);
      return el?.closest('[data-testid="controls-tab"]') !== null ? 'tab' : 'stage';
    }, [LANDSCAPE.width, LANDSCAPE.height]);
    expect(atCentre).toBe('stage');

    // --- it does not swallow trackpad gestures ------------------------------
    // A drag across the middle drives the pad cursor and must NOT be read as
    // "show me the controls".
    const before = (await page.getByTestId('crosshair').boundingBox())!;
    await page.mouse.move(LANDSCAPE.width / 2, LANDSCAPE.height / 2);
    await page.mouse.down();
    await page.mouse.move(LANDSCAPE.width / 2 + 120, LANDSCAPE.height / 2 + 60, { steps: 12 });
    await page.mouse.up();
    const after = (await page.getByTestId('crosshair').boundingBox())!;
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(10);
    await expect(tab).toBeVisible();

    // --- the tab opens the controls -----------------------------------------
    await tab.click();
    await expect(page.getByTestId('pointer-mode')).toBeVisible();
    await expect(tab).toHaveCount(0);
    await page.screenshot({ path: `../docs/screenshots/landscape-controls-${appearance.toLowerCase()}.png` });

    // --- a mode he chose sideways is remembered, not fought -----------------
    await withControls(page, () => page.getByTestId('pointer-mode-touch').click({ timeout: 2000 }));
    await expect.poll(() => selectedMode(page)).toBe('touch');
    await page.setViewportSize(PORTRAIT);
    await page.getByTestId('more-controls').click();
    await expect.poll(() => selectedMode(page)).toBe('touch');
    await page.getByTestId('sheet-close').click();
    await page.setViewportSize(LANDSCAPE);
    await expect(page.getByTestId('controls-tab')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('controls-tab').click();
    await expect.poll(() => selectedMode(page)).toBe('touch');
    await page.screenshot({ path: `../docs/screenshots/landscape-chosen-touch-${appearance.toLowerCase()}.png` });
  }

  await page.setViewportSize(PORTRAIT);
  expect(errors).toEqual([]);
});
