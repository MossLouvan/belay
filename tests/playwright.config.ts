import { defineConfig } from '@playwright/test';
import { APP_PORT, CODE, HOST_PORT } from './test-env';

// Drives the web build of the Tether app against a live host agent. Both are
// started by Playwright (see webServer below) so `npm test` needs no manual
// setup. Uses the system-installed Google Chrome via the 'chrome' channel, so
// there is no separate browser download. An iPhone-like mobile context (touch,
// 390x844, DPR 3) keeps the layout phone-accurate.
export default defineConfig({
  testDir: './specs',
  timeout: 40000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  // The host agent gets its own port and the fixed pairing code, and is never
  // reused: a stray agent would be running without TETHER_TEST_CODE and every
  // pair step would fail. The Expo dev server is safe to reuse — any instance
  // serving the app is equivalent, and a cold bundle takes minutes.
  webServer: [
    {
      command: 'npm start',
      cwd: '../server',
      url: `http://127.0.0.1:${HOST_PORT}/health`,
      env: { TETHER_PORT: String(HOST_PORT), TETHER_TEST_CODE: CODE },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx expo start --web --port ${APP_PORT}`,
      cwd: '../app',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
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
