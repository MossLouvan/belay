import { test, expect, Page, Locator } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// Keyboard avoidance, checked against the real web build.
//
// HONEST LIMIT, stated up front because it decides what these tests prove:
// react-native-web's `Keyboard` module never emits. `addListener` returns an
// inert subscription (react-native-web/dist/exports/Keyboard/index.js), so
// `useKeyboardLift` — and therefore `KeyboardAvoider` — cannot fire in a
// browser at all. No amount of event dispatching changes that; there is no
// listener on the other end.
//
// So these tests do not exercise the lift. They exercise the thing the lift
// hands its result to: whether each surface's layout can survive its viewport
// losing the keyboard's height and still keep the field AND the buttons that
// act on it inside the visible area. A surface that fails this would still be
// broken with a perfect lift, because the lift's whole effect is to shorten
// the viewport by exactly that much. The lift's own arithmetic is unit-tested
// in app/src/ui/keyboard.test.mjs.
//
// 390x844 is the iPhone viewport the config uses; 390x450 is that phone with
// a ~394pt keyboard up, which is the tallest an iPhone software keyboard with
// a QuickType row gets.

const FULL = { width: 390, height: 844 };
const KEYBOARD_UP = { width: 390, height: 450 };

const SHOTS = '../docs/screenshots';

/** Is the element's box entirely inside the viewport the page currently has? */
async function withinViewport(page: Page, locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  if (!box) return false;
  const size = page.viewportSize();
  if (!size) return false;
  return box.y >= 0 && box.y + box.height <= size.height + 1;
}

/**
 * A control the user must be able to reach while typing. Either it is already
 * on screen, or the surface it sits on can bring it there by scrolling — what
 * must never happen is that it is stuck under the fold with nowhere to go.
 */
async function expectReachable(page: Page, locator: Locator, what: string) {
  await expect(locator, `${what} should exist while the keyboard is up`).toBeVisible();
  if (await withinViewport(page, locator)) return;
  await locator.scrollIntoViewIfNeeded();
  expect(
    await withinViewport(page, locator),
    `${what} is under the keyboard and cannot be scrolled into view`
  ).toBe(true);
}

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

async function coldStart(page: Page) {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await intro(page);
}

async function pair(page: Page) {
  await coldStart(page);
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();

  const codeInput = page.getByTestId('code-input');
  const surface = page.getByTestId('screen-surface');
  await expect(codeInput.or(surface).first()).toBeVisible({ timeout: 15000 });
  if (await codeInput.isVisible()) {
    await codeInput.fill(CODE);
    await page.getByTestId('pair-btn').click();
  }
  await expect(surface).toBeVisible({ timeout: 15000 });
}

const openTool = (page: Page, id: 'agent' | 'terminal' | 'files' | 'system') =>
  page.getByTestId(`nav-${id}`).click();

test.describe('keyboard avoidance', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(FULL);
  });

  test('connect: the address field and Connect both survive the keyboard', async ({ page }) => {
    await coldStart(page);
    await page.screenshot({ path: `${SHOTS}/keyboard-connect-before.png` });

    await page.getByTestId('host-input').click();
    await page.setViewportSize(KEYBOARD_UP);

    await expectReachable(page, page.getByTestId('host-input'), 'the address field');
    await expectReachable(page, page.getByTestId('check-host'), 'Connect');
    await page.screenshot({ path: `${SHOTS}/keyboard-connect.png` });
  });

  test('connect: Pair stays reachable under six digit boxes and a paragraph', async ({ page }) => {
    await coldStart(page);
    await page.getByTestId('host-input').fill(HOST);
    await page.getByTestId('check-host').click();

    const codeInput = page.getByTestId('code-input');
    const surface = page.getByTestId('screen-surface');
    await expect(codeInput.or(surface).first()).toBeVisible({ timeout: 15000 });
    // On a machine whose tailnet is up the host pairs with no code at all, so
    // there is no code step to check. Say so rather than pretending.
    test.skip(!(await codeInput.isVisible()), 'host paired over the tailnet — no code step exists');

    await page.setViewportSize(KEYBOARD_UP);
    await expectReachable(page, codeInput, 'the code boxes');
    await expectReachable(page, page.getByTestId('pair-btn'), 'Pair');
    await page.screenshot({ path: `${SHOTS}/keyboard-connect-code.png` });
  });

  /**
   * Put text on the clipboard and make sure this page can read it back.
   *
   * The read-back is not ceremony: in Chrome under Playwright the very first
   * `navigator.clipboard.readText()` a page performs settles the granted
   * permission, and until it has, a read issued from inside a React handler
   * can sit pending rather than resolving or rejecting. That is a harness
   * quirk with no counterpart on a phone — iOS answers the read (behind its
   * own Allow Paste prompt) either way — so the priming read stays in the
   * test rather than being worked around in the app.
   */
  async function putOnClipboard(page: Page, text: string) {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await page.evaluate(() => navigator.clipboard.readText());
  }

  test('connect: Paste reads the clipboard and normalises what it finds', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await coldStart(page);

    // What a Tailscale copy actually looks like at its messiest: a full URL
    // with the host agent's own port and a trailing slash.
    await putOnClipboard(page, 'http://100.101.102.103:8787/');
    await page.getByTestId('paste-address').click();

    // The old handler destructured a `default` export expo-clipboard does not
    // have, so this stayed empty on every platform.
    await expect(page.getByTestId('host-input')).toHaveValue('100.101.102.103');
    await expect(page.getByTestId('address-feedback')).toContainText('Tailscale');
    await page.screenshot({ path: `${SHOTS}/keyboard-connect-paste.png` });
  });

  test('connect: a clipboard with nothing usable in it says so instead of going quiet', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await coldStart(page);

    await putOnClipboard(page, '   ');
    await page.getByTestId('paste-address').click();
    await expect(page.getByTestId('paste-error')).toBeVisible();
  });

  test('agent: the composer and Send clear the keyboard', async ({ page }) => {
    await pair(page);
    await openTool(page, 'agent');

    // The panel opens on the session list; "New session" is the way to a
    // surface with a field on it.
    await expect(page.getByTestId('agent-list')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('agent-new').click();

    const picker = page.getByTestId('agent-cwd');
    await expect(picker.or(page.getByTestId('agent-input')).first()).toBeVisible({ timeout: 15000 });
    if (await picker.isVisible()) {
      // The project picker first: its field and its Start button sit on the
      // same surface, and Start is the one below the fold.
      await page.screenshot({ path: `${SHOTS}/keyboard-agent-picker-before.png` });
      await picker.click();
      await page.setViewportSize(KEYBOARD_UP);
      await expectReachable(page, picker, 'the project folder field');
      await expectReachable(page, page.getByTestId('agent-start'), 'Start');
      await page.screenshot({ path: `${SHOTS}/keyboard-agent-picker.png` });

      // Then into a real session, which is where the composer and — when
      // Claude asks for something — the Allow / Deny pair live.
      await page.setViewportSize(FULL);
      await picker.fill(process.env.HOME ?? '~');
      await page.getByTestId('agent-start').click();
    }

    // A session is either the structured feed (composer + Send, and the
    // Allow / Deny card above it) or the real interactive CLI the host owns
    // (its own input and Type / Run). Both hang their bottom row off the same
    // panel-level avoider, so whichever this host opens is the one to check.
    const composer = page.getByTestId('agent-input');
    const ptyInput = page.getByTestId('agent-pty-input');
    await expect(composer.or(ptyInput).first()).toBeVisible({ timeout: 20000 });

    const isPty = await ptyInput.isVisible();
    const field = isPty ? ptyInput : composer;
    const action = page.getByTestId(isPty ? 'agent-pty-run' : 'agent-send');

    await page.screenshot({ path: `${SHOTS}/keyboard-agent-before.png` });
    await field.click();
    await page.setViewportSize(KEYBOARD_UP);
    await expectReachable(page, field, isPty ? 'the session input' : 'the prompt composer');
    await expectReachable(page, action, isPty ? 'Run' : 'Send');
    await page.screenshot({ path: `${SHOTS}/keyboard-agent.png` });
  });

  test('terminal: the command row and Run clear the keyboard', async ({ page }) => {
    await pair(page);
    await openTool(page, 'terminal');

    await expect(page.getByTestId('term-input')).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/keyboard-terminal-before.png` });

    await page.getByTestId('term-input').click();
    await page.setViewportSize(KEYBOARD_UP);
    await expectReachable(page, page.getByTestId('term-input'), 'the command field');
    await expectReachable(page, page.getByTestId('term-run'), 'Run');
    await page.screenshot({ path: `${SHOTS}/keyboard-terminal.png` });
  });

  test('files: the filter field survives, and the Go to sheet keeps its button', async ({ page }) => {
    await pair(page);
    await openTool(page, 'files');

    await expect(page.getByTestId('file-list')).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/keyboard-files-before.png` });

    await page.getByTestId('files-search').click();
    await page.setViewportSize(KEYBOARD_UP);
    await expectReachable(page, page.getByTestId('files-search'), 'the folder filter');
    await page.screenshot({ path: `${SHOTS}/keyboard-files.png` });

    // The sheet is the worst case of all: it is pinned to the bottom edge,
    // which is exactly where the keyboard arrives. Nothing used to move it.
    await page.setViewportSize(FULL);
    const goTo = page.getByTestId('files-goto');
    if (!(await goTo.count())) {
      test.skip(true, 'this build has no Go to control on the files panel');
      return;
    }
    await goTo.click();
    await expect(page.getByTestId('files-goto-input')).toBeVisible();
    await page.getByTestId('files-goto-input').click();
    await page.setViewportSize(KEYBOARD_UP);
    await expectReachable(page, page.getByTestId('files-goto-input'), 'the sheet field');
    await expectReachable(page, page.getByTestId('files-goto-go'), 'the sheet Go button');
    await page.screenshot({ path: `${SHOTS}/keyboard-sheet.png` });
  });
});
