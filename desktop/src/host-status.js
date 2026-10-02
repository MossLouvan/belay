// Pure pieces of the host role: what the menu bar says, what the pairing
// link carries, how a QR matrix becomes an SVG, and when to switch the login
// item on. No Electron here, so test/host-status.test.mjs runs them bare.

/**
 * Where the phone app comes from — the first thing the window points at.
 * ponytail: gobelay.com/get until the App Store listing is live; swap for the
 * apps.apple.com URL (or the TestFlight invite) here and nowhere else.
 */
export const PHONE_APP_URL = 'https://gobelay.com/get';

/**
 * The code and identity inside a `belay://pair` (or legacy `tether://`) link,
 * or the 8-character code and node id inside the account `belay://claim` link.
 */
export function parsePairing(link) {
  let url;
  try { url = new URL(String(link ?? '')); } catch { return null; }
  if (!/^(belay|tether):$/.test(url.protocol)) return null;
  if (url.host === 'claim') {
    const code = url.searchParams.get('c') ?? '';
    return /^[A-Z2-7]{8}$/.test(code) ? { code, hostId: url.searchParams.get('n') ?? '', label: '' } : null;
  }
  if (url.host !== 'pair') return null;
  const code = url.searchParams.get('c') ?? '';
  if (!/^\d{6,8}$/.test(code)) return null;
  return { code, hostId: url.searchParams.get('id') ?? '', label: url.searchParams.get('n') ?? '' };
}

/**
 * One SVG per QR: a path of unit squares on a quiet-zone border. `fg` is a
 * CSS colour, so the renderer can draw it in the ink the theme uses.
 */
export function qrSvg(modules, { fg = 'currentColor', quiet = 2 } = {}) {
  const n = Array.isArray(modules) ? modules.length : 0;
  if (n === 0) return '';
  const size = n + quiet * 2;
  const cells = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) cells.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<path fill="${fg}" d="${cells.join('')}"/></svg>`;
}

/** @typedef {{ phase: 'starting'|'running'|'busy'|'stopped', devices?: number, native?: boolean, port: number }} HostState */

/** The line under "Belay" in the menu, from the host's phase. */
export function statusLine(state) {
  switch (state.phase) {
    case 'running': {
      const n = state.devices ?? 0;
      return n === 0 ? 'Running · not linked yet' : `Running · ${n} phone${n === 1 ? '' : 's'}`;
    }
    case 'busy': return `Belay is already running on port ${state.port}`;
    case 'stopped': return 'Stopped';
    default: return 'Starting…';
  }
}

/**
 * Autostart is opt-in, like `npm run autostart`: never on at install, on by
 * itself the first time a phone links, and after that only the user's own
 * toggle (`prefs.openAtLogin`) counts. Returns the new prefs, or the same
 * object when nothing should change.
 */
export function loginItemAfterHealth(prefs, paired) {
  if (!paired || prefs.openAtLogin !== undefined) return prefs;
  return { ...prefs, openAtLogin: true };
}

/** What `/health` says, reduced to the fields the app shows; null when it is not ours. */
export function readHealth(body) {
  if (!body || body.ok !== true || typeof body.id !== 'string') return null;
  return {
    devices: Number.isInteger(body.devices) ? body.devices : (body.paired ? 1 : 0),
    native: body.native === true,
    paired: body.paired === true,
    name: typeof body.name === 'string' ? body.name : '',
  };
}

/** What the host's own pairing window lasts when its message predates `expiresInSec`. */
const DEFAULT_CODE_SEC = 300;

/**
 * The host's `pairing` message (server/src/banner.ts) as window state: the
 * link, its QR, and when the code stops working. Null when malformed.
 */
export function pairingFromMessage(data, now) {
  if (!data || typeof data.link !== 'string' || !Array.isArray(data.modules)) return null;
  const sec = Number.isFinite(data.expiresInSec) && data.expiresInSec > 0 ? data.expiresInSec : DEFAULT_CODE_SEC;
  return { link: data.link, modules: data.modules, expiresAt: now + sec * 1000 };
}

/** The pairing to show now, or null once its code has expired. */
export function livePairing(pairing, now) {
  return pairing && pairing.expiresAt > now ? pairing : null;
}
