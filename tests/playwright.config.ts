import { defineConfig } from '@playwright/test';
import { APP_ORIGIN, APP_PORT, CODE, HOST_PORT } from './test-env';

// Drives the web build of the Deskhandler app against a live host agent. Both are
// started by Playwright (see webServer below) so `npm test` needs no manual
// setup — previously it did, which is how a set of stale failure artifacts came
// to sit in the repo describing a bug that had already been fixed, with nobody
// able to cheaply disprove them.
//
// Uses the system-installed Google Chrome via the 'chrome' channel, so there is
// no separate browser download. An iPhone-like mobile context (touch, 390x844,
// DPR 3) keeps the layout phone-accurate.

export default defineConfig({
  testDir: './specs',
  timeout: 40000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],

  webServer: [
    {
      // The host agent under test, on its own port (see test-env) so a run
      // never collides with — or pairs against — a hand-started agent.
      //
      // DESKHANDLER_TEST_CODE fixes the pairing code so the suite can pair
      // repeatedly; the agent refuses that variable when NODE_ENV=production
      // and warns loudly at boot, so it cannot quietly weaken a real deployment.
      //
      // DESKHANDLER_STATE_FILE keeps test pairings out of the developer's real state
      // file — without it every run appends a live token to whatever state file
      // belongs to the directory the agent started in.
      //
      // Never reused: a stray agent would be running without DESKHANDLER_TEST_CODE,
      // and every pair step would fail against it.
      command: 'npm start',
      cwd: '../server',
      url: `http://127.0.0.1:${HOST_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DESKHANDLER_PORT: String(HOST_PORT),
        DESKHANDLER_TEST_CODE: CODE,
        DESKHANDLER_STATE_FILE: 'test-state.json',
        DESKHANDLER_ALLOWED_ORIGINS: `${APP_ORIGIN},http://localhost:${APP_PORT}`,
      },
    },
    {
      // The app's web build, via the same dev server developers use, so the
      // suite needs no separate export step before `playwright test`. Safe to
      // reuse — any instance serving the app is equivalent, and a cold Metro
      // start compiles the whole app.
      command: `npm run web -- --port ${APP_PORT}`,
      cwd: '../app',
      url: APP_ORIGIN,
      reuseExistingServer: true,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],

  use: {
    baseURL: APP_ORIGIN,
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
