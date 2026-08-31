// Connect window: pair with a host, then list its displays.
//
// The host's API is plain REST with a bearer token, so this talks to it
// directly rather than through the main process — the only things that cross
// IPC are the saved session and the request to open a display window.

import { hostOrigin } from '../src/url.js';
import { displaysOf, preferredDisplay } from '../src/displays.js';
import { windowsOf, windowLabel } from '../src/windows.js';
import { legendText, modifierMap } from '../src/modmap.js';

const $ = (id) => document.getElementById(id);
const state = { host: '', token: '', label: '', platform: '', keymap: 'remap' };
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

async function pair() {
  showError('');
  const origin = hostOrigin($('host').value);
  if (!origin) return showError('That does not look like an address. Try 192.168.1.20:8787');

  state.host = origin;
  const code = $('code').value.trim();
  setBusy(true, 'pairing…');
  try {
    // deviceName is what the host shows in its paired-devices list, so it says
    // which machine this is rather than just "desktop".
    const result = await call('/pair', {
      method: 'POST',
      body: { code, deviceName: `${navigator.platform || 'Desktop'} (Tether desktop)` },
    });
    state.token = String(result.token || '');
    state.label = String(result.name || origin);
    if (!state.token) throw new Error('the host did not return a token');
    await refreshPlatform();
    await window.tether.saveSession(state);
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
  await window.tether.saveSession(state);
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
    name.className = 'name';
    name.textContent = display.name;
    const size = document.createElement('div');
    size.className = 'dim';
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
    if (display === preferred) open.className = 'primary';
    open.addEventListener('click', () => window.tether.openDisplay(state, display));
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
    all.style.marginTop = '10px';
    all.addEventListener('click', () => window.tether.openWindows(state, openable));
    hint.after(all);
  }

  for (const remote of windows) {
    const row = document.createElement('li');

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'name';
    title.textContent = remote.app || 'Window';
    const detail = document.createElement('div');
    detail.className = 'dim';
    detail.textContent = remote.minimized
      ? `${remote.title} · minimized`
      : `${remote.title} · ${remote.w} × ${remote.h}`;
    left.append(title, detail);

    const open = document.createElement('button');
    open.textContent = 'Open';
    open.title = windowLabel(remote);
    open.disabled = remote.minimized || remote.w <= 0;
    open.addEventListener('click', () => window.tether.openWindows(state, [remote]));

    row.append(left, open);
    list.append(row);
  }
}

$('refresh-windows').addEventListener('click', showWindows);
$('keymap-remap').addEventListener('change', async (event) => {
  state.keymap = event.target.checked ? 'remap' : 'verbatim';
  await window.tether.saveSession(state);
  renderKeymap();
});
$('connect').addEventListener('click', pair);
for (const id of ['host', 'code']) {
  $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') pair(); });
}
$('forget').addEventListener('click', async () => {
  await window.tether.clearSession();
  location.reload();
});

// A saved session skips straight to the display list. The token is only proven
// good by a call that uses it, so a stale one (revoked on the host) falls back
// to the pairing form rather than showing an empty, broken list.
window.tether.readSession().then(async (saved) => {
  if (!saved?.host || !saved?.token) return;
  Object.assign(state, saved);
  try {
    await call('/me', { token: state.token });
    await showPaired();
  } catch {
    $('host').value = saved.host;
    showError('That pairing is no longer valid on the host. Pair again with a fresh code.');
  }
});
