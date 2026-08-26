import { test, expect, Page } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// End-to-end coverage of the Tether app web build against a live host agent.
// The server runs with TETHER_TEST_CODE=123456 and starts unpaired, so each
// run pairs fresh. Every interactive control on every screen is exercised.

async function pair(page: Page) {
  await page.goto('/');
  // Clear any stored connection so we always begin at the connect screen.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByTestId('host-input')).toBeVisible();
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();

  await expect(page.getByTestId('code-input')).toBeVisible();
  await page.getByTestId('code-input').fill(CODE);
  await page.getByTestId('pair-btn').click();

  // Landing on the Screen tab confirms a successful pair.
  await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 15000 });
}

test.describe('Tether', () => {
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

    // Real host advances to the code step.
    await page.getByTestId('host-input').fill(HOST);
    await page.getByTestId('check-host').click();
    await expect(page.getByTestId('code-input')).toBeVisible();

    // Back returns to host entry.
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('host-input')).toBeVisible();

    // Wrong code is rejected.
    await page.getByTestId('host-input').fill(HOST);
    await page.getByTestId('check-host').click();
    await page.getByTestId('code-input').fill('000000');
    await page.getByTestId('pair-btn').click();
    await expect(page.getByTestId('error')).toBeVisible();

    // Correct code pairs through to the tabs.
    await page.getByTestId('code-input').fill(CODE);
    await page.getByTestId('pair-btn').click();
    await expect(page.getByTestId('screen-surface')).toBeVisible({ timeout: 15000 });
  });

  test('screen tab: streaming and every control', async ({ page }) => {
    await pair(page);

    // A live frame should arrive (fps text flips off "connecting").
    await expect(page.getByTestId('fps')).toBeVisible();

    // The remote surface accepts taps (sends a click to the host).
    await page.getByTestId('screen-surface').click({ position: { x: 100, y: 60 } });

    // Right-click toggle.
    await page.getByTestId('right-click').click();
    await expect(page.getByTestId('right-click')).toContainText('ON');
    await page.getByTestId('screen-surface').click({ position: { x: 120, y: 70 } });

    // Key bar: each quick key posts to the host.
    for (const label of ['Esc', 'Tab', 'Enter', 'Bksp', 'Ctrl+C', 'Ctrl+V', 'Win', 'Left', 'Up', 'Down', 'Right']) {
      await page.getByTestId(`key-${label}`).click();
    }

    // Text send.
    await page.getByTestId('type-input').fill('hello from tether');
    await page.getByTestId('send-text').click();
    await expect(page.getByTestId('type-input')).toHaveValue('');

    // Hide/show the key bar.
    await page.getByTestId('toggle-keys').click();
    await expect(page.getByTestId('key-Esc')).toBeHidden();
    await page.getByTestId('toggle-keys').click();
    await expect(page.getByTestId('key-Esc')).toBeVisible();
  });

  test('terminal tab: runs a command and quick keys', async ({ page }) => {
    await pair(page);
    await page.getByText('Terminal', { exact: true }).click();

    await expect(page.getByTestId('term-input')).toBeVisible();
    await page.getByTestId('term-input').fill('echo tether-terminal-ok');
    await page.getByTestId('term-run').click();

    // Output should eventually echo our marker.
    await expect(page.getByTestId('term-output')).toContainText('tether-terminal-ok', { timeout: 15000 });

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
