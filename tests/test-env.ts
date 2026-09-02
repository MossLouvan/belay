// Shared between playwright.config.ts (which launches the servers) and the
// specs (which type the host address into the connect screen).
//
// The host agent runs on a dedicated test port so a suite run never collides
// with — or pairs against — a hand-started agent on the default 8787.
// BELAY_TEST_PORT overrides it for the case where 8799 is itself taken.

export const HOST_PORT = Number(process.env.BELAY_TEST_PORT || process.env.TETHER_TEST_PORT) || 8799;
export const APP_PORT = Number(process.env.BELAY_TEST_APP_PORT || process.env.TETHER_TEST_APP_PORT) || 8081;

export const HOST = `127.0.0.1:${HOST_PORT}`;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

// Matches BELAY_TEST_CODE, which playwright.config.ts passes to the agent
// alongside the BELAY_ALLOW_TEST_CODE=1 opt-in. The agent honours this fixed
// code only when that explicit opt-in is present and warns loudly at boot — so
// a stray inherited variable cannot quietly end up weakening a real deployment.
export const CODE = '123456';
