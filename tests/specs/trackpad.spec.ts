import { test, expect, Page } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// The deadspace trackpad has to be THERE. Not "rendered somewhere in the tree"
// — present, sized, and the topmost thing under the founder's thumb in every
// state he would reach for it, in both appearances and both orientations.
//
// It went missing once already: the redesign clipped the panel-state guidance
// to the stage rectangle it explains, but left the pad gated on that same
// guidance being absent, so the whole well below the stage went dead whenever
// there was no picture — permanently on a Mac whose screen-recording
// permission is off. Every assertion below is a state that bug ate.

const PORTRAIT = { width: 390, height: 844 } as const;
const LANDSCAPE = { width: 844, height: 390 } as const;

/**
 * What the browser actually delivers a touch at (x, y) to. Presence alone is
 * not the property under test — a pad painted over by a sibling is exactly as
 * missing as one that never mounted.
 */
async function hitAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px as number, py as number);
    if (!el) return 'none';
    const pad = (el as Element).closest('[data-testid="trackpad-surface"]');
    if (pad) return 'trackpad-surface';
    const owner = (el as Element).closest('[data-testid]');
    return owner ? String(owner.getAttribute('data-testid')) : (el as Element).tagName;
  }, [x, y]);
}

/** Assert the pad is mounted, has real area, and owns the touch at `point`. */
async function expectPad(page: Page, state: string, point?: { x: number; y: number }) {
  const pad = page.getByTestId('trackpad-surface');
  await expect(pad, `${state}: the trackpad should be mounted`).toHaveCount(1);
  const box = await pad.boundingBox();
  expect(box, `${state}: the trackpad should have a box`).not.toBeNull();
  expect(box!.width, `${state}: the trackpad should be wide enough to use`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${state}: the trackpad should be tall enough to use`).toBeGreaterThanOrEqual(44);
  const at = point ?? { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  expect(await hitAt(page, at.x, at.y), `${state}: the trackpad should be hit-testable, not covered`)
    .toBe('trackpad-surface');
}

async function pair(page: Page) {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  const welcome = page.getByTestId('welcome-continue');
  if (await welcome.isVisible()) {
    await welcome.click();
    await page.getByTestId('how-it-works-continue').click();
  }
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();
  const code = page.getByTestId('code-input');
  const surface = page.getByTestId('screen-surface');
  // Over the tailnet the host trusts its own peer and pairs with no code at
  // all; off it the code step appears. Either way the app then dwells on the
  // "Paired" notice before routing — and it routes to System, not Screen, on a
  // host with no native capture, so the nav below is not optional.
  const nav = page.getByTestId('nav-screen');
  await expect(code.or(surface).or(nav).first()).toBeVisible({ timeout: 30000 });
  if (await code.isVisible()) {
    await code.fill(CODE);
    await page.getByTestId('pair-btn').click();
  }
  await expect(surface.or(nav).first()).toBeVisible({ timeout: 30000 });
  if (!(await surface.count())) await nav.click();
  await expect(surface).toBeVisible({ timeout: 30000 });
}

async function chooseAppearance(page: Page, appearance: 'Current' | 'Fieldwork') {
  await page.getByTestId('screen-back').click();
  await page.getByTestId('choose-appearance').click();
  await page.getByTestId('appearance-picker').getByText(appearance, { exact: true }).click();
  await page.getByTestId('sheet-close').click();
  await page.getByTestId(/^device-/).first().click();
  await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 20000 });
}

test.describe('the deadspace trackpad is present in every state', () => {
  for (const appearance of ['Current', 'Fieldwork'] as const) {
    const tag = appearance.toLowerCase();

    test(`${appearance}: live picture, keyboard, fullscreen, landscape`, async ({ page }) => {
      test.setTimeout(150000);
      await pair(page);
      await chooseAppearance(page, appearance);
      await expect(page.getByTestId('panel-state')).toHaveCount(0, { timeout: 25000 });

      // 1. Portrait, windowed, live picture — the resting state.
      await expectPad(page, `${tag}/portrait-windowed`);
      await page.screenshot({ path: `../docs/screenshots/trackpad-${tag}-portrait.png` });

      // 2. The picture itself still wins its own touches: the pad is behind it,
      //    never over it.
      const stage = (await page.getByTestId('screen-surface').boundingBox())!;
      expect(await hitAt(page, stage.x + stage.width / 2, stage.y + stage.height / 2))
        .toBe('screen-surface');

      // 3. Keyboard / type row up: the dock grows and the panel shrinks, and
      //    the pad has to survive the squeeze rather than collapse to a line.
      await page.getByTestId('toggle-type').click();
      await expect(page.getByTestId('key-Esc')).toBeVisible();
      await expectPad(page, `${tag}/keyboard-open`);
      await page.screenshot({ path: `../docs/screenshots/trackpad-${tag}-keyboard.png` });
      await page.getByTestId('toggle-type').click();
      await expect(page.getByTestId('key-Esc')).not.toBeVisible();

      // 4. Portrait fullscreen: the stage letterboxes against a tall phone, and
      //    everything it does not claim is pad. Probe the band ABOVE the
      //    picture, not the screen's centre: the immersive stage is centred in
      //    the safe area now, so the centre is the picture and correctly owns
      //    its own touches. Same reasoning as the landscape step below.
      await page.getByTestId('stage-fullscreen').click();
      const tall = (await page.getByTestId('screen-surface').boundingBox())!;
      const band = tall.y;
      test.info().annotations.push({ type: 'fullscreen-letterbox-px', description: String(band) });
      if (band >= 8) {
        await expectPad(page, `${tag}/portrait-fullscreen`, { x: PORTRAIT.width / 2, y: band / 2 });
      } else {
        await expectPad(page, `${tag}/portrait-fullscreen`);
      }
      await page.screenshot({ path: `../docs/screenshots/trackpad-${tag}-fullscreen.png` });
      await page.getByTestId('stage-fullscreen').click();
      await expect(page.getByTestId('control-dock')).toBeVisible();

      // 5. Landscape: the picture goes edge to edge vertically, so the pad is
      //    the side letterbox bars. Probe one of them, not the centre.
      await page.setViewportSize(LANDSCAPE);
      await expect(page.getByTestId('trackpad-surface')).toHaveCount(1);
      const wide = (await page.getByTestId('screen-surface').boundingBox())!;
      const bar = wide.x;
      test.info().annotations.push({ type: 'landscape-letterbox-px', description: String(bar) });
      if (bar >= 8) {
        await expectPad(page, `${tag}/landscape`, { x: bar / 2, y: LANDSCAPE.height / 2 });
      }
      await page.screenshot({ path: `../docs/screenshots/trackpad-${tag}-landscape.png` });
      await page.setViewportSize(PORTRAIT);
      await expect(page.getByTestId('screen-surface')).toBeVisible();

      // 6. A tool panel covers the desktop on purpose — but leaving it must put
      //    the pad straight back under the thumb.
      await page.getByTestId('nav-files').click();
      await page.getByTestId('nav-screen').click();
      await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 20000 });
      await expectPad(page, `${tag}/after-tool-panel`);
    });

    test(`${appearance}: no picture — the panel-state guidance keeps its hands off the pad`, async ({ page }) => {
      test.setTimeout(150000);
      await pair(page);
      await chooseAppearance(page, appearance);

      // The regression, reproduced deterministically: hold the frame socket
      // open-but-dead so no picture ever arrives. `panelStateShown` then stays
      // true for the whole session — exactly what captureBlocked does on a Mac
      // whose screen-recording permission is off, and what a reconnect does for
      // as long as it lasts. The pad used to vanish with it.
      await page.routeWebSocket('**/ws/screen*', () => { /* never connect */ });
      await page.reload();
      await expect(page.getByTestId('panel-state')).toBeVisible({ timeout: 30000 });

      await expectPad(page, `${tag}/panel-state-portrait`);
      await page.screenshot({ path: `../docs/screenshots/trackpad-${tag}-panel-state.png` });

      // The guidance owns the stage rectangle it explains, and nothing below it.
      const guidance = (await page.getByTestId('panel-state').boundingBox())!;
      const pad = (await page.getByTestId('trackpad-surface').boundingBox())!;
      expect(pad.y, `${tag}: the pad must sit clear of the guidance`)
        .toBeGreaterThanOrEqual(guidance.y + guidance.height - 1);
    });
  }
});
