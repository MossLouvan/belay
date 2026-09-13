import { test, Page } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// Captures every screen in BOTH appearances for the App Store polish review.
// Not an assertion test — it produces images in ../docs/screenshots (gitignored).
// Run it alone:  npx playwright test specs/polish-shots.spec.ts

const DIR = '../docs/screenshots';
const PORTRAIT = { width: 390, height: 844 } as const;
const LANDSCAPE = { width: 844, height: 390 } as const;

type Appearance = 'current' | 'fieldwork';

const shot = (page: Page, name: string, look: Appearance) =>
  page.screenshot({ path: `${DIR}/polish-${name}-${look}.png` });

async function firstRun(page: Page, look: Appearance) {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  const welcome = page.getByTestId('welcome-continue');
  if (await welcome.isVisible().catch(() => false)) {
    await page.waitForTimeout(900);
    await shot(page, 'welcome', look);
    await welcome.click();
    await page.waitForTimeout(400);
    await shot(page, 'how-it-works', look);
    await page.getByTestId('how-it-works-continue').click();
  }
  await page.getByTestId('host-input').waitFor();
  await shot(page, 'connect', look);
}

async function pair(page: Page) {
  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();
  const code = page.getByTestId('code-input');
  const surface = page.getByTestId('screen-surface');
  const nav = page.getByTestId('nav-screen');
  await code.or(surface).or(nav).first().waitFor({ timeout: 30000 });
  if (await code.isVisible().catch(() => false)) {
    await code.fill(CODE);
    await page.getByTestId('pair-btn').click();
  }
  await surface.or(nav).first().waitFor({ timeout: 30000 });
  if (!(await surface.count())) await nav.click();
  await surface.waitFor({ timeout: 30000 });
}

/** Set the appearance from the computers list, then come back to the desktop. */
async function setAppearance(page: Page, look: Appearance) {
  await page.getByTestId('screen-back').click();
  await page.getByTestId('choose-appearance').click();
  const label = look === 'current' ? 'Current' : 'Fieldwork';
  await page.getByTestId('appearance-picker').getByText(label, { exact: true }).click();
  await page.getByTestId('sheet-close').click();
  await page.waitForTimeout(400);
}

async function tour(page: Page, look: Appearance) {
  // --- Computers (we are on it after setAppearance) ---
  await shot(page, 'computers', look);

  await page.getByTestId(/^device-/).first().click();
  await page.getByTestId('screen-surface').waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  await shot(page, 'screen-portrait', look);

  // --- Screen options sheet ---
  await page.getByTestId('screen-menu').click();
  await page.getByTestId('screen-menu-sheet').waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'screen-menu', look);
  await page.getByTestId('sheet-close').click();
  await page.waitForTimeout(300);

  // --- Screen, landscape (the immersive HUD) ---
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(1500);
  await shot(page, 'screen-landscape', look);
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(1200);

  // --- Terminal ---
  await page.getByTestId('nav-terminal').click();
  await page.getByTestId('term-input').waitFor({ timeout: 20000 });
  await page.getByTestId('term-input').fill('Get-Date');
  await page.getByTestId('term-run').click();
  await page.waitForTimeout(1800);
  await shot(page, 'terminal', look);

  // --- Files ---
  await page.getByTestId('nav-files').click();
  await page.getByTestId('file-list').waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  await shot(page, 'files', look);

  // --- System ---
  await page.getByTestId('nav-system').click();
  await page.waitForTimeout(1600);
  await shot(page, 'system', look);

  // --- Agent ---
  await page.getByTestId('nav-agent').click();
  await page.waitForTimeout(1600);
  await shot(page, 'agent', look);
}

for (const look of ['current', 'fieldwork'] as Appearance[]) {
  test(`capture every screen — ${look}`, async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize(PORTRAIT);
    await firstRun(page, look);
    await pair(page);
    await setAppearance(page, look);
    await tour(page, look);
  });
}
