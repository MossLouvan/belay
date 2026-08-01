// Shared between playwright.config.ts (which launches the servers) and the
// specs (which type the host address into the connect screen). The host agent
// runs on a dedicated test port so a suite run never collides with — or pairs
// against — a hand-started agent on the default 8787.

export const HOST_PORT = 8799;
export const APP_PORT = 8081;

export const HOST = `127.0.0.1:${HOST_PORT}`;

// Matches TETHER_TEST_CODE below; the agent accepts this fixed code only when
// that env var is set, which happens solely for these tests.
export const CODE = '123456';
