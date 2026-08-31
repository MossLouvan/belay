// One window of the host, shown as a window of this desktop.
//
// The seamless counterpart of display.js. Two things make it different from
// streaming a whole display, and both come from the same fact — a window is not
// a fixed rectangle:
//
//   * every frame carries the window's current size and title, so this window
//     follows them (size through the main process, which owns the BrowserWindow);
//   * the window can close, and when it does the stream says so and this window
//     closes with it rather than freezing on the last frame.
//
// Input is normalized against the *window*, not a monitor: the host maps 0..1
// onto that window's rectangle wherever it happens to be sitting, so the user
// aims at pixels in this window and the host clicks the same pixels in that one.

import { hostOrigin, socketOrigin } from '../src/url.js';
import { translateKey, modifiersOf } from '../src/keymap.js';
import { bareTapKey, legendText, modifierMap } from '../src/modmap.js';
import { aspectFit, scaleOf, shouldResize } from '../src/windows.js';

const params = new URLSearchParams(location.search);
const host = hostOrigin(params.get('host')) ?? '';
const token = params.get('token') ?? '';
const windowId = params.get('window') ?? '';
let name = params.get('name') ?? 'Window';

// See src/modmap.js: which modifier means what on this host, chosen once.
const clientIsMac = /mac/i.test(navigator.platform || '');
const keymap = modifierMap(clientIsMac, params.get('platform') || '', params.get('keymap') || 'remap');

const canvas = document.getElementById('screen');
const context = canvas.getContext('2d', { alpha: false });
const statusEl = document.getElementById('status');

/** Stream tuning for a single window: smaller than a display, so cheaper. */
const STREAM = { w: 1400, q: 65, fps: 24 };

/** The remote window's rectangle, as of the last frame. */
let rect = null;
/** The zoom this window is showing the remote one at; 1 until a frame arrives. */
let scale = 1;

let statusTimer = null;
function setStatus(text, sticky = false) {
  statusEl.textContent = text || '';
  clearTimeout(statusTimer);
  if (text && !sticky) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2200);
}

// ---- Input ---------------------------------------------------------------

async function send(path, body) {
  try {
    await fetch(host + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      // `window` is what makes this input land in the remote window rather than
      // at the same fraction of the whole desktop.
      body: JSON.stringify({ ...body, window: windowId }),
    });
  } catch {
    // The socket's own state reports a broken link; a lost click need not.
  }
}

function normalized(event) {
  const bounds = canvas.getBoundingClientRect();
  const x = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0;
  const y = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : 0;
  return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
}

/**
 * Raise the remote window on the host.
 *
 * Typed input goes to whatever has focus on the host, not to a window handle,
 * so a click here has to raise the remote window before the keystrokes that
 * follow can reach it. Done on first interaction rather than on every click:
 * raising on each one would fight the user for the host's foreground.
 */
let raised = false;
async function raise(force = false) {
  if (raised && !force) return;
  raised = true;
  try {
    const response = await fetch(host + '/windows/focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ window: windowId }),
    });
    const result = await response.json();
    if (result && result.focused === false) {
      setStatus('the host refused to raise this window — click the host once', true);
    }
  } catch { /* the stream will report a broken link */ }
}

const MOVE_INTERVAL_MS = 40;
let lastMoveAt = 0;
canvas.addEventListener('mousemove', (event) => {
  const now = Date.now();
  if (now - lastMoveAt < MOVE_INTERVAL_MS) return;
  lastMoveAt = now;
  void send('/input/move', normalized(event));
});

const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };
const DRAG_THRESHOLD = 0.004;
let pressed = null;

canvas.addEventListener('mousedown', (event) => {
  event.preventDefault();
  void raise();
  armedTap = null;
  pressed = { at: normalized(event), button: BUTTONS[event.button] ?? 'left' };
});

canvas.addEventListener('mouseup', (event) => {
  event.preventDefault();
  if (!pressed) return;
  const to = normalized(event);
  const { at, button } = pressed;
  pressed = null;
  if (Math.abs(to.x - at.x) > DRAG_THRESHOLD || Math.abs(to.y - at.y) > DRAG_THRESHOLD) {
    void send('/input/drag', { x1: at.x, y1: at.y, x2: to.x, y2: to.y });
    return;
  }
  void send('/input/click', { ...to, button, double: event.detail >= 2, mods: modifiersOf(event, keymap) });
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  void send('/input/scroll', { dy: -event.deltaY, dx: -event.deltaX });
}, { passive: false });

// A bare tap of whichever modifier is mapped to the Windows key opens the
// Start menu on the host — same contract as display.js, same disarm rules.
let armedTap = null;

window.addEventListener('keydown', (event) => {
  const translated = translateKey(event, keymap);
  if (!translated) {
    armedTap = bareTapKey(event.key, keymap) && modifiersOf(event, keymap).length === 1
      ? event.key
      : null;
    return;
  }
  armedTap = null;
  event.preventDefault();
  // Keystrokes go to whatever holds focus on the host, so the remote window has
  // to be in front before the first one is sent.
  void raise();
  if (translated.kind === 'text') void send('/input/text', { text: translated.text });
  else void send('/input/key', { key: translated.key, mods: translated.mods });
});

window.addEventListener('keyup', (event) => {
  if (event.key !== armedTap) return;
  armedTap = null;
  event.preventDefault();
  void raise();
  void send('/input/key', { key: bareTapKey(event.key, keymap), mods: [] });
});

window.addEventListener('blur', () => { pressed = null; });
// Focus is per remote window on the host, and something else may have taken it
// while this window was not in front — so the next interaction re-raises.
window.addEventListener('focus', () => { raised = false; });

document.getElementById('raise').addEventListener('click', () => raise(true));
document.getElementById('close').addEventListener('click', () => window.tether.closeSelf());

// ---- Stream --------------------------------------------------------------

async function socketUrl() {
  const url = new URL(socketOrigin(host) + '/ws/window');
  url.searchParams.set('window', windowId);
  url.searchParams.set('w', String(STREAM.w));
  url.searchParams.set('q', String(STREAM.q));
  url.searchParams.set('fps', String(STREAM.fps));
  try {
    const response = await fetch(host + '/ws-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: '{}',
    });
    if (!response.ok) throw new Error(String(response.status));
    const { ticket } = await response.json();
    url.searchParams.set('ticket', ticket);
  } catch {
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function draw(frame) {
  const image = new Image();
  image.onload = () => {
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    context.drawImage(image, 0, 0);
  };
  image.src = 'data:image/jpeg;base64,' + frame.data;
}

/**
 * Follow the remote window's size and title.
 *
 * The scale is recomputed from the *current* window before deciding, so a
 * resize the user did locally is preserved: the local window keeps showing the
 * remote one at whatever zoom they chose, and only a genuine remote resize
 * changes its size.
 */
function follow(frame) {
  if (frame.title && frame.title !== name) {
    name = frame.title;
    void window.tether.setTitle(name);
  }
  const next = frame.rect;
  if (!next || !(next.W > 0) || !(next.H > 0)) return;

  const current = { width: window.innerWidth, height: window.innerHeight };
  if (rect) scale = scaleOf(current, rect);
  if (shouldResize(current, next, scale)) {
    const size = aspectFit(next, scale);
    void window.tether.resizeSelf(size.width, size.height);
  }
  rect = next;
}

const RECONNECT = { base: 500, max: 8000 };
let attempt = 0;

async function connect() {
  setStatus(attempt === 0 ? 'connecting…' : 'reconnecting…', true);
  let socket;
  try {
    socket = new WebSocket(await socketUrl());
  } catch {
    retry();
    return;
  }

  socket.addEventListener('open', () => { attempt = 0; setStatus(''); });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    if (message?.type === 'frame') {
      follow(message);
      // A minimized window has no pixels to send. Keeping the last frame on
      // screen and saying so beats painting the window black.
      if (message.hidden) setStatus('minimized on the host', true);
      else if (typeof message.data === 'string') { setStatus(''); draw(message); }
    } else if (message?.type === 'gone') {
      // The remote window closed. This one has nothing left to show.
      setStatus('the remote window closed', true);
      socket.close();
      window.tether.closeSelf();
    } else if (message?.type === 'error') {
      setStatus(String(message.error).slice(0, 120), true);
    }
  });
  socket.addEventListener('close', retry);
  socket.addEventListener('error', () => socket.close());
}

/** Reconnects stop once the window is gone; `closed` guards the retry loop. */
let closed = false;
window.addEventListener('beforeunload', () => { closed = true; });

function retry() {
  if (closed) return;
  const delay = Math.min(RECONNECT.base * 2 ** attempt, RECONNECT.max);
  attempt += 1;
  setStatus('disconnected — retrying in ' + Math.round(delay / 1000) + 's', true);
  setTimeout(connect, delay);
}

if (!host || !token || !windowId) setStatus('missing host, token or window', true);
else {
  // The remap announced once, then out of the way: a frameless window has no
  // room for a permanent legend, but a silent remap would be a keyboard that
  // lies. The connect window keeps the durable statement.
  const legend = legendText(keymap);
  if (legend) setTimeout(() => setStatus(legend), 1200);
  void connect();
}
