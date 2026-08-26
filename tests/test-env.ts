// Shared between playwright.config.ts (which launches the servers) and the
// specs (which type the host address into the connect screen).
//
// The host agent runs on a dedicated test port so a suite run never collides
// with — or pairs against — a hand-started agent on the default 8787.
// TETHER_TEST_PORT overrides it for the case where 8799 is itself taken.

export const HOST_PORT = Number(process.env.TETHER_TEST_PORT) || 8799;
export const APP_PORT = Number(process.env.TETHER_TEST_APP_PORT) || 8081;

export const HOST = `127.0.0.1:${HOST_PORT}`;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

// Matches TETHER_TEST_CODE, which playwright.config.ts passes to the agent.
// The agent accepts this fixed code only when that variable is set, refuses it
// outright under NODE_ENV=production, and warns loudly at boot — so it cannot
// quietly end up weakening a real deployment.
export const CODE = '123456';
