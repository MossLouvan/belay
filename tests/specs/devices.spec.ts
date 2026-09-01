import { test, expect, Page } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// Coverage for the saved-computers list — the screen the multi-computer model
// exists for. Pairing writes a computer here rather than overwriting a single
// global connection, and the list is what a user without a live connection is
// sent to, because it is the only screen that can explain why.
// Mirrors STORE_KEY in app/src/devices/storage.ts, whose prefix moved with
// the bundle id — the two must move together or every readStore goes blind.
const STORE_KEY = 'belay.devices.v1';

async function pair(page: Page) {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await pairFrom(page);
}

async function pairFrom(page: Page) {
  await expect(page.getByTestId('host-input')).toBeVisible();
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();

  // On a machine whose Tailscale is up, the host advertises its 100.x address,
  // the app upgrades to it, and the host trusts its own tailnet peer — so
  // pairing completes with no code, which is precisely the owner's real path.
  // Off the tailnet the code screen appears instead; the helper walks either.
  const codeInput = page.getByTestId('code-input');
  const surface = page.getByTestId('screen-surface');
  await expect(codeInput.or(surface).first()).toBeVisible({ timeout: 15000 });
  if (await codeInput.isVisible()) {
    await codeInput.fill(CODE);
    await page.getByTestId('pair-btn').click();
  }

  // Landing on the Screen tab confirms a successful pair.
  await expect(surface).toBeVisible({ timeout: 15000 });
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
    // advertises, so a later connection has more than one path to try. Which
    // one wins depends on where the suite runs: off the tailnet it is the
    // typed 127.0.0.1; with Tailscale up the app upgrades to the advertised
    // 100.x address and pairs there instead. Either way the winner must be
    // among the saved addresses, or the next launch races paths that never
    // include the one known to work.
    const urls = device.addresses.map((a: { url: string }) => a.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(device.lastKnownGoodUrl).toBeTruthy();
    expect(urls).toContain(device.lastKnownGoodUrl);
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

  test('Add a computer opens the pairing form instead of bouncing back', async ({ page }) => {
    // The second computer is the whole point of the list — and the connect
    // screen's redirect used to bounce anyone with a saved computer straight
    // back here, making this button a door that opened onto itself.
    await pair(page);
    await page.goto('/devices');
    await page.getByRole('button', { name: 'Add a computer' }).click();

    await expect(page.getByTestId('host-input')).toBeVisible();
    // Not pre-filled with the machine already paired — the one address that
    // cannot be the answer when adding another.
    await expect(page.getByTestId('host-input')).toHaveValue('');

    // And the way back is explicit, not just the browser's back gesture.
    await page.getByTestId('cancel-add').click();
    await expect(page.getByText(/paired · tap one to take control/)).toBeVisible();
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
    await page.getByRole('button', { name: 'Forget this computer' }).click();

    // Stays on the list and offers the way forward, rather than bouncing the
    // user to a form they did not ask for.
    await expect(page.getByText('No computers yet')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Add a computer' })).toBeVisible();

    const after = await readStore(page, STORE_KEY);
    expect(after.devices).toHaveLength(0);
    expect(after.activeId).toBeNull();
  });
});
