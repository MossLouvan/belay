import { test } from '@playwright/test';

// Captures a screenshot of each screen at iPhone size for visual review.
// Not an assertion test — it just produces images in ../screenshots.

// Port is overridable so the suite can run beside an agent you already have
// going, instead of demanding sole ownership of 8787.
const PORT = process.env.TETHER_TEST_PORT || '8787';
const HOST = `127.0.0.1:${PORT}`;
const CODE = '123456';
const DIR = '../screenshots';

test('capture all screens', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await page.getByTestId('host-input').waitFor();
  await page.screenshot({ path: `${DIR}/01-connect.png` });

  await page.getByTestId('host-input').fill(HOST);
  await page.getByTestId('check-host').click();
  await page.getByTestId('code-input').waitFor();
  await page.getByTestId('code-input').fill(CODE);
  await page.screenshot({ path: `${DIR}/02-pair.png` });

  await page.getByTestId('pair-btn').click();
  await page.getByTestId('screen-surface').waitFor();
  await page.waitForTimeout(2500); // let a frame or two arrive
  await page.screenshot({ path: `${DIR}/03-screen.png` });

  await page.getByText('Terminal', { exact: true }).click();
  await page.getByTestId('term-input').fill('Get-Date');
  await page.getByTestId('term-run').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${DIR}/04-terminal.png` });

  await page.getByText('Files', { exact: true }).click();
  await page.getByTestId('file-list').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${DIR}/05-files.png` });

  await page.getByText('System', { exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${DIR}/06-system.png` });
});
