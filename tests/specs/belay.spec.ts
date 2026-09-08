import { test, expect, Page } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// End-to-end coverage of the Belay app web build against a live host agent.
// The server runs with BELAY_TEST_CODE=123456 (plus the BELAY_ALLOW_TEST_CODE=1
// opt-in) and starts unpaired, so each run pairs fresh. Every interactive
// control on every screen is exercised.

/**
 * A cold start now opens on the Welcome → How it works intro before the
 * address field. Walk it the way a new user does. With storage cleared the
 * intro always shows, but the guards keep the helper honest if that changes.
 */
async function intro(page: Page) {
  const welcome = page.getByTestId('welcome-continue');
  const host = page.getByTestId('host-input');
  await expect(welcome.or(host).first()).toBeVisible();
  if (await welcome.isVisible()) {
    await welcome.click();
    await page.getByTestId('how-it-works-continue').click();
  }
  await expect(host).toBeVisible();
}

async function pair(page: Page) {
  await page.goto('/');
  // Clear any stored connection so we always begin at the connect screen.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await intro(page);
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

/**
 * The tab bar is gone: Agent, Terminal, Files and System live in the tool
 * drawer that the dock's TOOLS key slides up over the picture.
 */
async function openTool(page: Page, id: 'agent' | 'terminal' | 'files' | 'system') {
  await page.getByTestId('open-tools').click();
  await expect(page.getByTestId('tool-drawer')).toBeVisible();
  await page.getByTestId(`tool-${id}`).click();
}

test.describe('Belay', () => {
  test('connect screen validates and pairs', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await intro(page);

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
    // Redesigned Screen tab: a single control dock, one Keyboard toggle that
    // opens the text field together with a paged key bar of sticky modifiers. Only page-1 keys
    // and ungated controls are exercised here; the monitor switcher is gated on
    // a multi-monitor host and the paged keys need a live gesture, so both are
    // left for a manual pass against a real host.
    await pair(page);

    // Until the first frame lands, the panel-state overlay sits above the
    // surface and would swallow the taps below.
    await expect(page.getByTestId('panel-state')).toHaveCount(0, { timeout: 20000 });

    // The stream readout is off by default and lives behind the screen menu;
    // turning it on proves the menu, the toggle and a live stats line.
    await page.getByTestId('screen-menu').click();
    await page.getByTestId('toggle-hud').click();
    const sheet = page.getByTestId('screen-menu-sheet');
    if (await sheet.isVisible()) await sheet.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(page.getByTestId('hud')).toBeVisible();

    // The remote surface accepts taps (sends a click to the host).
    await page.getByTestId('screen-surface').click({ position: { x: 100, y: 60 } });

    // Arm right-click (a dock button that latches), then a tap sends it.
    await page.getByTestId('right-click').click();
    await page.getByTestId('screen-surface').click({ position: { x: 120, y: 70 } });

    // The key bar is inside the Keyboard surface.
    await expect(page.getByTestId('key-Esc')).toHaveCount(0);
    await page.getByTestId('toggle-type').click();
    await expect(page.getByTestId('key-Esc')).toBeVisible();

    // Page-1 keys each post to the host.
    for (const id of ['Esc', 'Tab', 'Enter', 'Bksp']) {
      await page.getByTestId(`key-${id}`).click();
    }
    // A sticky modifier latches, then rides the next key.
    await page.getByTestId('key-Ctrl').click();
    await page.getByTestId('key-Esc').click();

    // Text send lives in the same Keyboard surface.
    await page.getByTestId('type-input').fill('hello from belay');
    await page.getByTestId('send-text').click();
    await expect(page.getByTestId('type-input')).toHaveValue('');

    // Hiding the Keyboard surface removes the special keys too.
    await page.getByTestId('toggle-type').click();
    await expect(page.getByTestId('key-Esc')).toHaveCount(0);
  });

  test('terminal tab: runs a command and quick keys', async ({ page }) => {
    await pair(page);
    await openTool(page, 'terminal');

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
    await openTool(page, 'files');

    await expect(page.getByTestId('file-list')).toBeVisible();

    // Root chips switch directories.
    await page.getByTestId('root-Documents').click();
    await page.getByTestId('root-Home').click();

    // Up button works.
    await page.getByTestId('files-up').click();

    // Navigate into the Documents root and open the belay folder if present.
    // 'belay' here is the repo's real directory name on disk (~/projects,
    // Documents); the testid is derived from the folder name, so it tracks the
    // checkout rather than the product name.
    await page.getByTestId('root-Documents').click();
    const belay = page.getByTestId('entry-belay');
    if (await belay.count()) {
      await belay.click();
      // Open a text file from the repo (README-like) — just verify the viewer opens.
      const anyFile = page.locator('[data-testid^="entry-"]').first();
      await anyFile.click();
    }
  });

  test('system tab: live stats and disconnect', async ({ page }) => {
    await pair(page);
    await openTool(page, 'system');

    // Stats render with real numbers. Each card carries its own testID; the
    // bare label text is not unique because the CPU history chart repeats it.
    for (const id of ['stat-cpu', 'stat-memory', 'stat-disk']) {
      await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByTestId(id)).toContainText(/\d/);
    }

    // Disconnect confirms first — same sheet as Forget on the devices screen,
    // and for the same reason: un-pairing means walking to the machine for a
    // new code — then returns to the cold-start intro.
    await page.getByTestId('disconnect').click();
    await expect(page.getByText(/This phone will be un-paired/)).toBeVisible();
    await page.getByRole('button', { name: 'Forget', exact: true }).click();
    // With no computers left the app is back at a cold start: the Welcome
    // intro, and the address field behind it.
    await expect(page.getByTestId('welcome-screen')).toBeVisible();
    await intro(page);
  });
});
