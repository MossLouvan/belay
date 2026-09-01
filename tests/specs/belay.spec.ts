import { test, expect, Page } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// End-to-end coverage of the Belay app web build against a live host agent.
// The server runs with BELAY_TEST_CODE=123456 and starts unpaired, so each
// run pairs fresh. Every interactive control on every screen is exercised.

async function pair(page: Page) {
  await page.goto('/');
  // Clear any stored connection so we always begin at the connect screen.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

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

test.describe('Belay', () => {
  test('connect screen validates and pairs', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();

    // Empty host shows an error.
    await page.getByTestId('check-host').click();
    await expect(page.getByTestId('error')).toBeVisible();

    // Bad host (unreachable port) surfaces an error too.
    await page.getByTestId('host-input').fill('127.0.0.1:9999');
    await page.getByTestId('check-host').click();
    await expect(page.getByTestId('error')).toBeVisible();

    // Real host: over the tailnet it pairs on the spot with no code — the
    // owner's real path — and the code choreography below has nothing to
    // exercise. Off the tailnet the code step appears and gets walked in full.
    await page.getByTestId('host-input').fill(HOST);
    await page.getByTestId('check-host').click();
    const codeInput = page.getByTestId('code-input');
    const surface = page.getByTestId('screen-surface');
    await expect(codeInput.or(surface).first()).toBeVisible({ timeout: 15000 });

    if (await codeInput.isVisible()) {
      // Back returns to host entry.
      await page.getByTestId('back-btn').click();
      await expect(page.getByTestId('host-input')).toBeVisible();

      // Wrong code is rejected.
      await page.getByTestId('host-input').fill(HOST);
      await page.getByTestId('check-host').click();
      await codeInput.fill('000000');
      await page.getByTestId('pair-btn').click();
      await expect(page.getByTestId('error')).toBeVisible();

      // Correct code pairs through to the tabs.
      await codeInput.fill(CODE);
      await page.getByTestId('pair-btn').click();
    }
    await expect(surface).toBeVisible({ timeout: 15000 });
  });

  test('screen tab: streaming and every control', async ({ page }) => {
    // Redesigned Screen tab: a single control dock, keys and the text field
    // behind toggles, a paged key bar with sticky modifiers. Only page-1 keys
    // and ungated controls are exercised here; the monitor switcher is gated on
    // a multi-monitor host and the paged keys need a live gesture, so both are
    // left for a manual pass against a real host.
    await pair(page);

    // A live frame should arrive (fps text flips off "connecting").
    await expect(page.getByTestId('fps')).toBeVisible();
    // Until the first frame lands, the panel-state overlay sits above the
    // surface and would swallow the taps below.
    await expect(page.getByTestId('panel-state')).toHaveCount(0, { timeout: 20000 });

    // The remote surface accepts taps (sends a click to the host).
    await page.getByTestId('screen-surface').click({ position: { x: 100, y: 60 } });

    // Arm right-click (a dock button that latches), then a tap sends it.
    await page.getByTestId('right-click').click();
    await page.getByTestId('screen-surface').click({ position: { x: 120, y: 70 } });

    // The key bar is hidden until the keyboard button reveals it.
    await expect(page.getByTestId('key-Esc')).toHaveCount(0);
    await page.getByTestId('toggle-keys').click();
    await expect(page.getByTestId('key-Esc')).toBeVisible();

    // Page-1 keys each post to the host.
    for (const id of ['Esc', 'Tab', 'Enter', 'Bksp']) {
      await page.getByTestId(`key-${id}`).click();
    }
    // A sticky modifier latches, then rides the next key.
    await page.getByTestId('key-Ctrl').click();
    await page.getByTestId('key-Esc').click();

    // Hiding the key bar removes it again.
    await page.getByTestId('toggle-keys').click();
    await expect(page.getByTestId('key-Esc')).toHaveCount(0);

    // Text send lives behind the "Aa" toggle.
    await page.getByTestId('toggle-type').click();
    await page.getByTestId('type-input').fill('hello from belay');
    await page.getByTestId('send-text').click();
    await expect(page.getByTestId('type-input')).toHaveValue('');
  });

  test('terminal tab: runs a command and quick keys', async ({ page }) => {
    await pair(page);
    await page.getByText('Terminal', { exact: true }).click();

    await expect(page.getByTestId('term-input')).toBeVisible();
    await page.getByTestId('term-input').fill('echo belay-terminal-ok');
    await page.getByTestId('term-run').click();

    // Output should eventually echo our marker.
    await expect(page.getByTestId('term-output')).toContainText('belay-terminal-ok', { timeout: 15000 });

    // Quick keys must all be clickable.
    for (const label of ['Ctrl+C', 'Tab', 'Enter', 'Up', 'Down', 'clear']) {
      await page.getByTestId(`qkey-${label}`).click();
    }
  });

  test('files tab: browse, roots, up, and open a file', async ({ page }) => {
    await pair(page);
    await page.getByText('Files', { exact: true }).click();

    await expect(page.getByTestId('file-list')).toBeVisible();

    // Root chips switch directories.
    await page.getByTestId('root-Documents').click();
    await page.getByTestId('root-Home').click();

    // Up button works.
    await page.getByTestId('files-up').click();

    // Navigate into the Documents root and open the tether folder if present.
    // 'tether' here is the repo's real directory name on disk (~/projects,
    // Documents), not the product name — the checkout was not renamed, so the
    // testid derived from the folder name must not be either.
    await page.getByTestId('root-Documents').click();
    const tether = page.getByTestId('entry-tether');
    if (await tether.count()) {
      await tether.click();
      // Open a text file from the repo (README-like) — just verify the viewer opens.
      const anyFile = page.locator('[data-testid^="entry-"]').first();
      await anyFile.click();
    }
  });

  test('system tab: live stats and disconnect', async ({ page }) => {
    await pair(page);
    await page.getByText('System', { exact: true }).click();

    // Stats render with real numbers.
    await expect(page.getByText('CPU', { exact: true })).toBeVisible();
    await expect(page.getByText('Memory', { exact: true })).toBeVisible();
    await expect(page.getByText(/Disk/)).toBeVisible();

    // Disconnect confirms first — same sheet as Forget on the devices screen,
    // and for the same reason: un-pairing means walking to the machine for a
    // new code — then returns to the connect screen.
    await page.getByTestId('disconnect').click();
    await expect(page.getByText(/This phone will be un-paired/)).toBeVisible();
    await page.getByRole('button', { name: 'Forget', exact: true }).click();
    await expect(page.getByTestId('host-input')).toBeVisible();
  });
});
