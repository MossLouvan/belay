import { test, expect } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// The desktop thumbnail on a device card, driven end to end against a live
// host: pair, open the machine, go back, and prove the card is showing a real
// picture of that machine's desktop rather than the empty glyph tile. Captures
// the result in both appearances, plus the two states where there is nothing
// to draw.
//
// Screenshots land in ../docs/screenshots and are the evidence for the
// feature; the assertions are what make the run a test rather than a photo
// shoot.

const SHOTS = '../docs/screenshots';

async function pair(page: import('@playwright/test').Page): Promise<void> {
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
  await expect(page.getByTestId('screen-surface')).toBeVisible();
}

async function chooseAppearance(page: import('@playwright/test').Page, appearance: string): Promise<void> {
  await page.getByTestId('choose-appearance').click();
  await page.getByTestId('appearance-picker').getByText(appearance, { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('belay.themeMode')))
    .toBe(appearance.toLowerCase());
  await page.getByTestId('sheet-close').click();
}

test('a device card shows the desktop you were just looking at, in both appearances', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await pair(page);
  const hostId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.includes('belay.devices'));
    return JSON.parse(localStorage.getItem(key as string) as string).devices[0].id as string;
  });

  for (const appearance of ['Fieldwork', 'Current']) {
    // Pairing lands on the desktop; every later pass already ended on the list.
    const back = page.getByTestId('screen-back');
    if (await back.isVisible().catch(() => false)) await back.click();
    await expect(page.getByTestId('computer-card-' + hostId)).toBeVisible();
    await chooseAppearance(page, appearance);

    // Open the machine, let real frames land, then go back — exactly the
    // sequence the ask describes ("go back, it shows the view you just had").
    await page.getByTestId(/^device-[0-9a-f]/).first().click();
    await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.getByTestId('screen-back').click();

    const preview = page.getByTestId(/^computer-preview-/).first();
    await expect(preview).toBeVisible({ timeout: 15000 });
    // A real picture, not an empty tile: the card must actually be carrying
    // JPEG bytes. React Native Web draws an Image as a div with a
    // background-image (and a hidden <img> for alt text), so the payload can
    // be on either — check both rather than assuming one renderer.
    const payload = await preview.evaluate((el) => {
      const background = getComputedStyle(el).backgroundImage || '';
      const inner = el.querySelector('img')?.getAttribute('src') || '';
      return background.includes('data:image') ? background : inner;
    });
    expect(payload).toContain('data:image/jpeg;base64,');
    expect(payload.length).toBeGreaterThan(2000);

    await page.screenshot({ path: `${SHOTS}/device-preview-${appearance.toLowerCase()}.png` });
  }

  expect(errors).toEqual([]);
});

test('a computer that has never been opened and is unreachable keeps the empty tile', async ({ page }) => {
  test.setTimeout(120000);
  await pair(page);
  await page.getByTestId('screen-back').click();

  // A second saved computer at an address nothing answers on: never opened, so
  // no stream frame, and unreachable, so no still can be fetched either. This
  // is the state the empty glyph tile exists for.
  const unreachable = {
    id: 'never-opened-host',
    label: 'Studio PC',
    platform: 'win32',
    addresses: [{ kind: 'lan', url: 'http://127.0.0.1:9' }],
    token: 'not-a-real-token',
    addedAt: Date.now(),
  };
  await page.evaluate((device) => {
    // AsyncStorage's web backend is localStorage; find the device store by its
    // key rather than assuming how the backend spells the prefix.
    const key = Object.keys(localStorage).find((k) => k.includes('belay.devices'));
    if (!key) throw new Error('no saved device store to extend');
    const store = JSON.parse(localStorage.getItem(key) as string);
    store.devices = [...store.devices, device];
    localStorage.setItem(key, JSON.stringify(store));
  }, unreachable);
  await page.reload();

  const card = page.getByTestId(`computer-card-${unreachable.id}`);
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId(`computer-thumb-${unreachable.id}`)).toBeVisible();
  await expect(page.getByTestId(`computer-preview-${unreachable.id}`)).toHaveCount(0);
  // Give the offline probe time to resolve so the shot shows the dimmed state.
  await expect(card.getByText('Offline')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/device-preview-empty-offline.png` });
});
