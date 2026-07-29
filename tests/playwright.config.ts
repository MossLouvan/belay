import { defineConfig } from '@playwright/test';

// Drives the exported web build of the Tether app (served on 8081) against a
// live host agent (on 8787). Uses the system-installed Google Chrome via the
// 'chrome' channel, so there is no separate browser download. An iPhone-like
// mobile context (touch, 390x844, DPR 3) keeps the layout phone-accurate.
export default defineConfig({
  testDir: './specs',
  timeout: 40000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8081',
    channel: 'chrome',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'iphone' }],
});
