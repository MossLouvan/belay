import { defineConfig } from '@playwright/test';

// Drives the web build of the Tether app (served on 8081) against a live host
// agent (on 8787). Uses the system-installed Google Chrome via the 'chrome'
// channel, so there is no separate browser download. An iPhone-like mobile
// context (touch, 390x844, DPR 3) keeps the layout phone-accurate.
//
// Both servers are started by Playwright. Previously they were not, so
// `npx playwright test` failed for anyone who did not already know to hand-start
// two processes with a specific environment variable — which is how a set of
// stale failure artifacts came to sit in the repo describing a bug that had
// already been fixed, with nobody able to cheaply disprove them.
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
      // The host agent under test. TETHER_TEST_CODE fixes the pairing code so
      // the suite can pair repeatedly; the agent refuses that variable when
      // NODE_ENV=production and warns loudly at boot, so it cannot quietly end
      // up weakening a real deployment.
      //
      // TETHER_STATE_FILE keeps test pairings out of the developer's real state
      // file — without it every run appends a live token to whatever state file
      // belongs to the directory the agent started in.
      command: 'npm start',
      cwd: '../server',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        TETHER_PORT: '8787',
        TETHER_TEST_CODE: '123456',
        TETHER_STATE_FILE: 'test-state.json',
        TETHER_ALLOWED_ORIGINS: 'http://127.0.0.1:8081,http://localhost:8081',
      },
    },
    {
      // The app's web build, via the same dev server developers use, so the
      // suite needs no separate export step before `playwright test`.
      command: 'npm run web -- --port 8081',
      cwd: '../app',
      url: 'http://127.0.0.1:8081',
      reuseExistingServer: !process.env.CI,
      // Generous: a cold Metro start compiles the whole app.
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],

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
