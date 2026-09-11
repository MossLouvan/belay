import { test } from '@playwright/test';
import { CODE, HOST } from '../test-env';

// Captures a screenshot of each screen at iPhone size for visual review.
// Not an assertion test — it just produces images in ../screenshots.

const DIR = '../screenshots';

test('capture all screens', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  // The first run walks the welcome and how-it-works cards before the address
  // form; both are worth a shot of their own.
  const welcome = page.getByTestId('welcome-continue');
  if (await welcome.isVisible().catch(() => false)) {
    await page.screenshot({ path: `${DIR}/00-welcome.png` });
    await welcome.click();
    await page.getByTestId('how-it-works-continue').click();
  }
  await page.getByTestId('host-input').waitFor();
  await page.screenshot({ path: `${DIR}/01-connect.png` });

  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();

  // Over the owner's own tailnet pairing is codeless and the code screen never
  // exists — so neither does its screenshot. Off the tailnet, capture it.
  const codeInput = page.getByTestId('code-input');
  const surface = page.getByTestId('screen-surface');
  await codeInput.or(surface).first().waitFor();
  if (await codeInput.isVisible()) {
    await codeInput.fill(CODE);
    await page.screenshot({ path: `${DIR}/02-pair.png` });
    await page.getByTestId('pair-btn').click();
  }
  await surface.waitFor();
  await page.waitForTimeout(2500); // let a frame or two arrive
  await page.screenshot({ path: `${DIR}/03-screen.png` });

  await page.getByTestId('nav-terminal').click();
  await page.getByTestId('term-input').fill('Get-Date');
  await page.getByTestId('term-run').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${DIR}/04-terminal.png` });

  await page.getByTestId('nav-files').click();
  await page.getByTestId('file-list').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${DIR}/05-files.png` });

  await page.getByTestId('nav-system').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${DIR}/06-system.png` });
});
