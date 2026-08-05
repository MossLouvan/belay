import { test, expect, Page } from '@playwright/test';

// Coverage for the saved-computers list — the screen the multi-computer model
// exists for. Pairing writes a computer here rather than overwriting a single
// global connection, and the list is what a user without a live connection is
// sent to, because it is the only screen that can explain why.

const HOST = '127.0.0.1:8787';
const CODE = '123456';
const STORE_KEY = 'tether.devices.v1';

async function pair(page: Page) {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByTestId('host-input')).toBeVisible();
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();

  await expect(page.getByTestId('code-input')).toBeVisible();
  await page.getByTestId('code-input').fill(CODE);
  await page.getByTestId('pair-btn').click();

  await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 15000 });
}

/** The persisted store, as the app would read it back on next launch. */
async function readStore(page: Page, key: string) {
  return page.evaluate((k) => {
    const raw = window.localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key);
}

test.describe('Computer list', () => {
  test('pairing saves a computer with an identity and its addresses', async ({ page }) => {
    await pair(page);

    const store = await readStore(page, STORE_KEY);
    expect(store).not.toBeNull();
    expect(store.version).toBe(1);
    expect(store.devices).toHaveLength(1);

    const device = store.devices[0];
    // Keyed on the host's own id, never the URL — the URL is what changes.
    expect(device.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(device.token).toBeTruthy();
    expect(device.platform).toBe('darwin');
    expect(store.activeId).toBe(device.id);

    // The address that actually worked is saved, plus whatever the host
    // advertises, so a later connection has more than one path to try.
    const urls = device.addresses.map((a: { url: string }) => a.url);
    expect(urls).toContain(`http://${HOST}`);
    expect(device.lastKnownGoodUrl).toBe(`http://${HOST}`);
  });

  test('the list shows the paired computer and can reach it', async ({ page }) => {
    await pair(page);

    await page.goto('/devices');
    await expect(page.getByText('My computers')).toBeVisible();

    const store = await readStore(page, STORE_KEY);
    const device = store.devices[0];

    const row = page.getByTestId(`device-${device.id}`);
    await expect(row).toBeVisible();
    // Probed live by racing its addresses, so this is "reached it just now".
    await expect(page.getByText(/Mac · (Connected|Ready)/)).toBeVisible({ timeout: 15000 });

    // Tapping it takes control.
    await row.click();
    await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 15000 });
  });

  test('a saved computer that cannot be reached lands on the list, not a spinner', async ({ page }) => {
    await pair(page);

    // Rewrite the saved addresses to a dead port. The token stays valid — this
    // is the "left the house, the LAN address no longer resolves" case, which
    // used to strand the user on "Reconnecting… (attempt 47)" with no way back
    // except Disconnect, which threw the token away.
    await page.evaluate((k) => {
      const store = JSON.parse(window.localStorage.getItem(k) as string);
      store.devices[0].addresses = [{ kind: 'lan', url: 'http://127.0.0.1:9999' }];
      delete store.devices[0].lastKnownGoodUrl;
      window.localStorage.setItem(k, JSON.stringify(store));
    }, STORE_KEY);

    await page.goto('/');
    await expect(page.getByText('My computers')).toBeVisible({ timeout: 20000 });
    // Says what is wrong rather than retrying silently forever.
    await expect(page.getByText(/Asleep or off/)).toBeVisible({ timeout: 20000 });
    // And the computer is still saved, so recovering does not mean re-pairing.
    const store = await readStore(page, STORE_KEY);
    expect(store.devices).toHaveLength(1);
    expect(store.devices[0].token).toBeTruthy();
  });

  test('forgetting a computer clears it and offers to add another', async ({ page }) => {
    await pair(page);
    await page.goto('/devices');

    const store = await readStore(page, STORE_KEY);
    const device = store.devices[0];

    await page.getByLabel(`Forget ${device.label}`).click();
    // Confirmed rather than done on the first tap — un-pairing means walking to
    // the machine for a new code, so it should not be one stray touch away.
    await expect(page.getByText(/This phone will be un-paired/)).toBeVisible();
    await page.getByRole('button', { name: 'Forget', exact: true }).click();

    // Stays on the list and offers the way forward, rather than bouncing the
    // user to a form they did not ask for.
    await expect(page.getByText('No computers yet')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Add a computer' })).toBeVisible();

    const after = await readStore(page, STORE_KEY);
    expect(after.devices).toHaveLength(0);
    expect(after.activeId).toBeNull();
  });
});
