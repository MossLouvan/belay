// Connect window: pair with a host, then list its displays.
//
// The host's API is plain REST with a bearer token, so this talks to it
// directly rather than through the main process — the only things that cross
// IPC are the saved session and the request to open a display window.

import { hostOrigin, isTailscaleOrigin } from '../src/url.js';
import { displaysOf, preferredDisplay } from '../src/displays.js';
import { windowsOf, windowLabel } from '../src/windows.js';
import { legendText, modifierMap } from '../src/modmap.js';
import { EXAMPLE_TAILSCALE_ADDRESS, addressFeedback } from '../src/address-feedback.js';
import { displayFingerprint, freshNonce, normalizeFingerprint, plaintextOk, proofMatches } from '../src/proof.js';
import { attachBeluga } from './beluga.js';

const $ = (id) => document.getElementById(id);
const state = { host: '', token: '', label: '', platform: '', keymap: 'remap', fingerprint: '', deviceId: '', secret: '' };
const clientIsMac = /mac/i.test(navigator.platform || '');

function showError(message) {
  $('error').textContent = message || '';
}

function setBusy(busy, note = '') {
  $('connect').disabled = busy;
  $('status').textContent = note;
}

/**
 * A fetch that fails loudly and in the host's own words.
 *
 * The host answers every error with `{ error }`, and that text is the useful
 * one ("invalid or expired pairing code"), so it is preferred over the status
 * code whenever it is there.
 */
async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${state.host}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* a body is optional */ }
  if (!response.ok) throw new Error(payload?.error || `host returned ${response.status}`);
  return payload ?? {};
}

/**
 * Before any request carries the token: is this the computer we paired with?
 *
 * The host id in /health is public, so a stranger holding the same address
 * could echo it. A host that issued a secret at pairing must answer a fresh
 * challenge with the right HMAC (src/proof.js). A pairing from before secrets
 * existed can only be used where the link is private without TLS — Tailscale
 * or this machine — and must otherwise be redone.
 */
async function verifyHost() {
  if (state.deviceId && state.secret) {
    const nonce = freshNonce(crypto);
    const reply = await call('/challenge', { method: 'POST', body: { deviceId: state.deviceId, nonce } })
      .catch(() => null);
    if (!(await proofMatches(state.secret, nonce, reply?.proof, crypto))) {
      throw new Error('Something answered at that address but could not prove it is the computer this client paired with. Nothing was sent to it.');
    }
    return;
  }
  if (/^https:/i.test(state.host) || plaintextOk(state.host)) return;
  throw new Error('That computer now encrypts connections on this network, and this pairing is from before it did. Pair again with a fresh code.');
}

/**
 * Trust on first use for a typed https address: read the certificate the
 * host presents, pin it, and show its fingerprint so the user can compare it
 * with the Cert line in the host's window. A pasted pairing link carries the
 * fingerprint itself and needs no comparing.
 */
async function pinTypedOrigin(origin, fromLink) {
  if (!/^https:/i.test(origin)) return '';
  const fingerprint = fromLink || await window.belay.probeFingerprint(origin);
  await window.belay.pinFingerprint(origin, fingerprint);
  $('cert').hidden = false;
  $('cert-value').textContent = displayFingerprint(fingerprint);
  $('cert-hint').textContent = fromLink
    ? 'From the pairing link — this is the certificate the host printed.'
    : 'Check this matches the Cert line in the Belay window on that computer. If it differs, something else is answering at this address.';
  return fingerprint;
}

async function pair() {
  showError('');
  const link = parsePairLink($('host').value);
  if (link?.fingerprint) state.fingerprint = link.fingerprint;
  const origin = link ? await firstReachable(link.addresses) : hostOrigin($('host').value);
  if (!origin) return showError(link ? 'None of that computer\'s addresses answered from here.' : 'That does not look like an address. Try 192.168.1.20:8787');

  state.host = origin;
  let fingerprint = '';
  try {
    fingerprint = await pinTypedOrigin(origin, link?.fingerprint ?? '');
  } catch (e) {
    return showError(`Could not read that computer's certificate (${e.message}). Check it is running the Belay host on this network.`);
  }
  // Over Tailscale the host pairs on the peer's identity; a code is neither
  // needed nor checked, so an empty one is the normal case, not an error.
  const tailnet = isTailscaleOrigin(origin);
  const code = link ? link.code : (tailnet ? '' : $('code').value.trim());
  if (!tailnet && !code) return showError('Type the pairing code shown on that computer, or use its Tailscale address to skip it.');
  setBusy(true, tailnet ? 'pairing over Tailscale…' : 'pairing…');
  try {
    // deviceName is what the host shows in its paired-devices list, so it says
    // which machine this is rather than just "desktop".
    const result = await call('/pair', {
      method: 'POST',
      body: { code, deviceName: `${navigator.platform || 'Desktop'} (Belay desktop)` },
    });
    state.token = String(result.token || '');
    state.label = String(result.name || origin);
    if (!state.token) throw new Error('the host did not return a token');
    // The host names its certificate in the reply; it must be the one that
    // was pinned for this pairing, or the pairing went somewhere else.
    const reported = normalizeFingerprint(result.fingerprint) || '';
    if (fingerprint && reported && reported !== fingerprint) {
      throw new Error('the computer\'s certificate does not match the one shown here');
    }
    state.fingerprint = fingerprint || reported;
    state.deviceId = String(result.deviceId || '');
    state.secret = String(result.secret || '');
    await refreshPlatform();
    await window.belay.saveSession(state);
    await showPaired();
  } catch (e) {
    showError(e.message);
  } finally {
    setBusy(false, '');
  }
}

/**
 * Render the display list for the paired host.
 *
 * A host that enumerates no monitors still gets one entry: the phone-era
 * behaviour of "whatever the host calls primary", requested by sending no
 * index at all. Without it an older host would look like it had no screens.
 */
/**
 * The host's platform, from the unauthenticated half of /health.
 *
 * The modifier remap cannot be chosen without knowing what is on the other
 * end, so it is refreshed on every visit rather than trusted from the saved
 * session — the same address can be a reinstalled machine running the other
 * OS. Failure keeps whatever was saved; the map for an unknown platform is
 * the untranslated one, which is the only honest guess.
 */
async function refreshPlatform() {
  try {
    const health = await call('/health');
    state.platform = String(health.platform || '');
  } catch { /* keep the remembered platform */ }
}

/**
 * State the modifier mapping and offer the switch.
 *
 * Shown even when nothing is remapped ("keys are sent as pressed"), because
 * the absence of a remap is also something the user may be looking for. The
 * toggle only appears where remap and verbatim actually differ.
 */
function renderKeymap() {
  const map = modifierMap(clientIsMac, state.platform, state.keymap);
  const legend = legendText(map);
  $('keymap-legend').textContent = legend || 'Keys are sent as pressed.';
  $('keymap-toggle').hidden = !map.adjustable;
  $('keymap-remap').checked = state.keymap !== 'verbatim';
  $('keymap-note').textContent = map.adjustable
    ? 'Changing this applies to display windows opened from now on.'
    : '';
}

async function showPaired() {
  await refreshPlatform();
  await window.belay.saveSession(state);
  renderKeymap();
  $('pair').hidden = true;
  $('paired').hidden = false;
  $('subtitle').textContent = 'Open a display in its own window.';
  $('paired-name').textContent = state.label;
  $('paired-host').textContent = state.host;

  const list = $('displays');
  list.textContent = '';
  $('hint').textContent = '';

  let displays = [];
  try {
    displays = displaysOf(await call('/screen/info', { token: state.token }));
  } catch (e) {
    showError(e.message);
    return;
  }

  if (displays.length === 0) {
    displays = [{ index: undefined, name: 'Main display', w: 0, h: 0, primary: true, virtual: false }];
  }

  const preferred = preferredDisplay(displays);
  for (const display of displays) {
    const row = document.createElement('li');

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name mono';
    name.textContent = display.name;
    const size = document.createElement('div');
    size.className = 'mono-dim';
    size.textContent = display.w > 0 ? `${display.w} × ${display.h}` : 'size unknown';
    left.append(name, size);

    const right = document.createElement('div');
    right.className = 'row';
    if (display.virtual) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'virtual';
      right.append(badge);
    }
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.className = display === preferred ? 'button primary sm' : 'button secondary sm';
    open.addEventListener('click', () => window.belay.openDisplay(state, display));
    right.append(open);

    row.append(left, right);
    list.append(row);
  }

  void showWindows();

  if (!displays.some((d) => d.virtual)) {
    $('hint').textContent =
      'No virtual display found on this host. Opening a physical one takes over the screen '
      + 'someone at that computer is using — see docs/VIRTUAL-MONITOR.md to add one.';
  }
}

/**
 * The host's open windows, each openable as a local window.
 *
 * A host whose helper cannot enumerate windows answers 501, and that is a
 * statement worth showing rather than an empty list: seamless mode is a Windows
 * feature today, and a macOS user should be told that instead of wondering why
 * their windows are missing.
 */
async function showWindows() {
  const list = $('windows');
  const hint = $('windows-hint');
  list.textContent = '';
  hint.textContent = 'loading…';

  let windows = [];
  try {
    windows = windowsOf(await call('/windows', { token: state.token }));
  } catch (e) {
    hint.textContent = e.message;
    return;
  }

  const openable = windows.filter((w) => !w.minimized && w.w > 0 && w.h > 0);
  hint.textContent = openable.length === 0
    ? 'No open windows to show.'
    : `${openable.length} window${openable.length === 1 ? '' : 's'} · minimized windows cannot be streamed until they are restored on the host.`;

  if (openable.length > 1) {
    const all = document.createElement('button');
    all.textContent = `Open all ${openable.length}`;
    all.className = 'button secondary sm actions';
    all.addEventListener('click', () => window.belay.openWindows(state, openable));
    hint.after(all);
  }

  for (const remote of windows) {
    const row = document.createElement('li');

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'name mono';
    title.textContent = remote.app || 'Window';
    const detail = document.createElement('div');
    detail.className = 'mono-dim';
    detail.textContent = remote.minimized
      ? `${remote.title} · minimized`
      : `${remote.title} · ${remote.w} × ${remote.h}`;
    left.append(title, detail);

    const open = document.createElement('button');
    open.textContent = 'Open';
    open.className = 'button secondary sm';
    open.title = windowLabel(remote);
    open.disabled = remote.minimized || remote.w <= 0;
    open.addEventListener('click', () => window.belay.openWindows(state, [remote]));

    row.append(left, open);
    list.append(row);
  }
}

attachBeluga($('beluga'));
$('refresh-windows').addEventListener('click', showWindows);
$('keymap-remap').addEventListener('change', async (event) => {
  state.keymap = event.target.checked ? 'remap' : 'verbatim';
  await window.belay.saveSession(state);
  renderKeymap();
});
$('connect').addEventListener('click', pair);
for (const id of ['host', 'code']) {
  $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') pair(); });
}
// The code field steps aside as soon as the address is a Tailscale one.
function syncCodeField() {
  const tailnet = isTailscaleOrigin(hostOrigin($('host').value));
  $('code').disabled = tailnet;
  $('code').placeholder = tailnet ? 'not needed over Tailscale' : '123456';
  $('code-hint').textContent = tailnet
    ? 'This is a Tailscale address — the host recognises this computer, no code needed.'
    : 'Leave blank when connecting over Tailscale.';
}
// The live line under the address, in the app's voice: the example while the
// field is empty, then reassurance, a nudge, or the reason it will not do.
function syncFeedback() {
  const line = addressFeedback($('host').value);
  $('feedback').dataset.tone = line ? line.tone : 'example';
  $('feedback').textContent = line ? line.text : `e.g. ${EXAMPLE_TAILSCALE_ADDRESS}`;
}
$('host').addEventListener('input', () => { syncCodeField(); syncFeedback(); });
syncCodeField();
syncFeedback();
// "Where do I find it?" unfolds the Tailscale walkthrough in place.
$('where').addEventListener('click', () => {
  const open = $('where').getAttribute('aria-expanded') !== 'true';
  $('where').setAttribute('aria-expanded', String(open));
  $('where-panel').hidden = !open;
});
// Escape dismisses the error line. Claimed locally without hesitation: unlike
// the display windows, nothing typed here is ever forwarded to the host.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') showError('');
});
$('forget').addEventListener('click', async () => {
  await window.belay.clearSession();
  location.reload();
});

// A saved session skips straight to the display list. The token is only proven
// good by a call that uses it, so a stale one (revoked on the host) falls back
// to the pairing form rather than showing an empty, broken list.
window.belay.readSession().then(async (saved) => {
  if (!saved?.host || !saved?.token) return;
  Object.assign(state, saved);
  try {
    await verifyHost();
  } catch (e) {
    $('host').value = saved.host;
    showError(e.message);
    return;
  }
  try {
    await call('/me', { token: state.token });
    await showPaired();
  } catch {
    $('host').value = saved.host;
    showError('That pairing is no longer valid on the host. Pair again with a fresh code.');
  }
});

/**
 * A pasted `belay://pair?…` link (the QR's contents), or null. Mirrors
 * server/src/pair-link.ts: id, code and at least one http(s) address are
 * required; the certificate fingerprint rides in `f`.
 */
function parsePairLink(text) {
  let url;
  try { url = new URL(String(text ?? '').trim()); } catch { return null; }
  if (url.protocol !== 'belay:' && url.protocol !== 'tether:') return null;
  if (url.hostname !== 'pair' && url.pathname.replace(/\//g, '') !== 'pair') return null;
  const p = url.searchParams;
  const addresses = p.getAll('a').filter((a) => /^https?:\/\//i.test(a));
  const code = p.get('c') ?? '';
  if (p.get('v') !== '1' || !p.get('id') || !/^\d{6}$/.test(code) || addresses.length === 0) return null;
  return { code, addresses, fingerprint: normalizeFingerprint(p.get('f')) ?? '' };
}

/** The first of a link's addresses whose /health answers from here, or null. */
async function firstReachable(addresses) {
  const probes = addresses.map(async (origin) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      // /health over https needs the pin in place before the probe.
      if (/^https:/i.test(origin) && state.fingerprint) await window.belay.pinFingerprint(origin, state.fingerprint);
      const res = await fetch(`${origin}/health`, { signal: controller.signal });
      return res.ok ? origin : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  const results = await Promise.all(probes);
  return results.find(Boolean) ?? null;
}
