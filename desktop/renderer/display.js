// One remote display, streamed into this window and driven from it.
//
// Frames arrive as JPEG over /ws/screen (binary, or base64 JSON from an older
// host) exactly as they do for the phone app; input goes back over the REST
// endpoints. Coordinates cross the
// wire normalized 0..1 against the display being shown, and every input request
// carries that display's index, so the pixels the user aims at and the pixels
// the host clicks are the same ones even on a multi-monitor host.

import { hostOrigin, socketOrigin } from '../src/url.js';
import { translateKey, modifiersOf } from '../src/keymap.js';
import { bareTapKey, legendText, modifierMap } from '../src/modmap.js';
import { streamConfig } from '../src/gamepad-session.js';
import { emptyLatch, offer, settle } from '../src/frame-latch.js';
import { decodeBase64Frame, decodeBinaryFrame } from '../src/binary-frame.js';
import { reconnectDelay, secondStatus, stalled } from '../src/stream-link.js';
import { attachGamepad } from './gamepad.js';

const params = new URLSearchParams(location.search);
const host = hostOrigin(params.get('host')) ?? '';
const token = params.get('token') ?? '';
const name = params.get('name') ?? 'Display';
// Absent (an old host with no monitor list) means "the host's primary", and
// must stay absent all the way to the wire rather than becoming a 0.
const rawScreen = params.get('screen');
const screenIndex = rawScreen === null || rawScreen === '' || rawScreen === 'undefined'
  ? undefined
  : Number(rawScreen);

// Which modifier means what is decided here, once, from the host platform the
// main process passed in and the mode the user picked on the connect screen.
// See src/modmap.js for why ⌘ is Ctrl when a Mac drives a Windows PC.
const clientIsMac = /mac/i.test(navigator.platform || '');
const keymap = modifierMap(clientIsMac, params.get('platform') || '', params.get('keymap') || 'remap');

// Test-only counters for test/harness (?stats=1): messages received, frames
// that reached the canvas, frames the latch discarded, stalls abandoned.
// Absent in normal use.
const probe = params.get('stats') === '1' ? { received: 0, drawn: 0, dropped: 0, stalls: 0 } : null;
if (probe) window.__belayStats = probe;

const canvas = document.getElementById('screen');
const context = canvas.getContext('2d', { alpha: false });
const overlay = document.getElementById('overlay');
document.getElementById('title').textContent = name;
// The active remap, stated where the user can see it: a keyboard whose keys
// secretly mean other keys is only tolerable while it says so.
document.getElementById('keys').textContent = legendText(keymap);

/** Stream tuning. Higher than the phone's defaults: this is a desktop on a LAN. */
const STREAM = { w: 1600, q: 62, fps: 24 };
let gaming = false;
let streamSocket = null;
const currentConfig = () => streamConfig(gaming, STREAM, screenIndex);
function retune() {
  if (streamSocket?.readyState !== WebSocket.OPEN) return;
  try { streamSocket.send(JSON.stringify(currentConfig())); } catch { /* the socket is on its way out; close follows */ }
}
attachGamepad({
  host, token, indicator: document.getElementById('controller'), toggle: document.getElementById('gaming'),
  onGaming: enabled => { gaming = enabled; overlay.classList.toggle('gaming', enabled); retune(); },
});

function setStatus(text, bad = false, live = false) {
  const stats = document.getElementById('stats');
  stats.textContent = text;
  // `live` lights the accent dot; the accent marks activity and nothing else,
  // so it leaves the moment the stream is anything but flowing.
  stats.className = bad ? 'bad' : live ? 'live' : '';
}

// ---- Input ---------------------------------------------------------------

async function send(path, body) {
  try {
    await fetch(host + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      // `screen` is undefined for an old host and JSON.stringify drops it, so
      // those hosts receive byte-for-byte the requests they always did.
      body: JSON.stringify({ ...body, screen: screenIndex }),
    });
  } catch {
    // A dropped input request is not worth interrupting the stream for: the
    // socket's own state is what tells the user the link is gone.
  }
}

/** Pointer position as a fraction of the remote display, clamped to it. */
function normalized(event) {
  const rect = canvas.getBoundingClientRect();
  const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
  return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
}

// Pointer motion is rate-limited to roughly the frame rate. Every mousemove the
// OS delivers would otherwise be an HTTP request — hundreds a second, all but
// the last of which is stale before the host acts on it.
const MOVE_INTERVAL_MS = 40;
let lastMoveAt = 0;
canvas.addEventListener('mousemove', (event) => {
  wake();
  const now = Date.now();
  if (now - lastMoveAt < MOVE_INTERVAL_MS) return;
  lastMoveAt = now;
  void send('/input/move', normalized(event));
});

const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };
/** Movement (in fractions of the display) past which a press is a drag, not a click. */
const DRAG_THRESHOLD = 0.004;
let pressed = null;

canvas.addEventListener('mousedown', (event) => {
  event.preventDefault();
  armedTap = null;
  pressed = { at: normalized(event), button: BUTTONS[event.button] ?? 'left' };
});

canvas.addEventListener('mouseup', (event) => {
  event.preventDefault();
  if (!pressed) return;
  const to = normalized(event);
  const { at, button } = pressed;
  pressed = null;
  // A press that moved is a drag; the host has a single endpoint that presses,
  // moves and releases, which is the only way to express one over stateless
  // REST without the button staying down if the release request is lost.
  if (Math.abs(to.x - at.x) > DRAG_THRESHOLD || Math.abs(to.y - at.y) > DRAG_THRESHOLD) {
    void send('/input/drag', { x1: at.x, y1: at.y, x2: to.x, y2: to.y });
    return;
  }
  void send('/input/click', {
    ...to,
    button,
    double: event.detail >= 2,
    mods: modifiersOf(event, keymap),
  });
});

// The context menu belongs to the remote desktop, not to this window: without
// this the local menu appears and the right-click never reaches the host.
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  wake();
  void send('/input/scroll', { dy: -event.deltaY, dx: -event.deltaX });
}, { passive: false });

// A bare tap of the modifier mapped to the Windows key must *do* something —
// the Windows key alone opens the Start menu, and reaching it is the point of
// the ⌥→Win remap. Held-and-combined it travels as a `mods` entry like any
// modifier; only a press with nothing between it and the release becomes the
// named key. Any other keydown or a click disarms the tap, so ⌥E never also
// opens Start.
let armedTap = null;

window.addEventListener('keydown', (event) => {
  if (event.target.closest?.('button')) return;
  const translated = translateKey(event, keymap);
  if (!translated) {
    armedTap = bareTapKey(event.key, keymap) && modifiersOf(event, keymap).length === 1
      ? event.key
      : null;
    return;
  }
  armedTap = null;
  // Swallowed before the local window acts on it: Ctrl+W would otherwise close
  // this window instead of the tab on the remote desktop.
  event.preventDefault();
  wake();
  if (translated.kind === 'text') void send('/input/text', { text: translated.text });
  else void send('/input/key', { key: translated.key, mods: translated.mods });
});

window.addEventListener('keyup', (event) => {
  if (event.target.closest?.('button')) return;
  if (event.key !== armedTap) return;
  armedTap = null;
  event.preventDefault();
  wake();
  void send('/input/key', { key: bareTapKey(event.key, keymap), mods: [] });
});

// A button held when the window loses focus would stay down on the host with
// nothing left to release it — the pointer then drags everything it touches.
window.addEventListener('blur', () => { pressed = null; });

// ---- Overlay -------------------------------------------------------------

let idleTimer = null;
function wake() {
  overlay.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => overlay.classList.add('idle'), 2500);
}
wake();

// ---- Stream --------------------------------------------------------------

/**
 * A single-use ticket for the socket.
 *
 * The token must not travel in a WebSocket URL — query strings land in logs and
 * history, and this one grants full control of the machine. The host trades it
 * for a ticket that is single-use and short-lived. A host too old to offer
 * /ws-ticket falls back to the token, matching the phone app.
 */
async function socketUrl() {
  const url = new URL(socketOrigin(host) + '/ws/screen');
  // Ask for binary pixel frames (see server/src/frame-codec.ts for the wire
  // layout). An old host ignores the param and keeps sending JSON, which the
  // message handler below still accepts — the two shapes share one socket.
  url.searchParams.set('bin', '1');
  const config = currentConfig();
  url.searchParams.set('w', String(config.w));
  url.searchParams.set('q', String(config.q));
  url.searchParams.set('fps', String(config.fps));
  if (screenIndex !== undefined) url.searchParams.set('screen', String(screenIndex));
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


// ---- Frames ----------------------------------------------------------------
//
// Every frame, binary or legacy JSON, becomes a Blob and goes through one
// newest-wins latch (src/frame-latch.js): one decode in flight, at most one
// waiting, everything older discarded. createImageBitmap decodes off the main
// thread; drawing is then a copy. A decode that fails frees the slot like one
// that succeeds, so a bad frame can never leave the latch busy for good.

let latch = emptyLatch();
let second = { drawn: 0, bytes: 0 };
let lastMessageAt = performance.now();

function drawBitmap(bitmap) {
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  second = { ...second, drawn: second.drawn + 1 };
  if (probe) probe.drawn += 1;
}

async function decode(blob) {
  try {
    drawBitmap(await createImageBitmap(blob));
  } catch {
    // Undecodable pixels are skipped; the next frame is a fresh chance.
  } finally {
    const next = settle(latch);
    latch = next.latch;
    if (next.decode) void decode(next.decode);
  }
}

function present(jpeg) {
  second = { ...second, bytes: second.bytes + jpeg.length };
  const next = offer(latch, new Blob([jpeg], { type: 'image/jpeg' }));
  if (probe) probe.dropped = next.latch.dropped;
  latch = next.latch;
  if (next.decode) void decode(next.decode);
}

function onMessage(data) {
  lastMessageAt = performance.now();
  if (probe) probe.received += 1;
  if (data instanceof ArrayBuffer) {
    const frame = decodeBinaryFrame(data);
    if (frame) present(frame.jpeg);
    return;
  }
  let message;
  try { message = JSON.parse(data); } catch { return; }
  if (message?.type === 'frame') {
    const jpeg = decodeBase64Frame(message.data);
    if (jpeg) present(jpeg);
  } else if (message?.type === 'error') {
    // The host's capture errors are the actionable ones — on macOS this is
    // where a missing Screen Recording grant announces itself.
    setStatus(String(message.error).slice(0, 120), true);
  }
}

// ---- Link ------------------------------------------------------------------
//
// One live socket at a time, named by a generation number. Every listener
// checks it is still the current generation before acting, so a socket that
// has been superseded — by a reconnect, or by the stall watchdog giving up on
// it — can fire `close` (or never fire it) without touching the new one.

let generation = 0;
let attempt = 0;
let retryTimer = null;

const current = (epoch) => epoch === generation;

async function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const epoch = generation + 1;
  generation = epoch;
  setStatus(attempt === 0 ? 'connecting…' : 'reconnecting…');
  let socket;
  try {
    socket = new WebSocket(await socketUrl());
  } catch {
    if (current(epoch)) retry();
    return;
  }
  // Superseded while the ticket was in flight: this socket was never wanted.
  if (!current(epoch)) { socket.close(); return; }

  // Binary frames must arrive as ArrayBuffer, not the default Blob.
  socket.binaryType = 'arraybuffer';
  streamSocket = socket;
  lastMessageAt = performance.now();
  socket.addEventListener('open', () => {
    if (!current(epoch)) return;
    attempt = 0;
    lastMessageAt = performance.now();
    retune();
    setStatus('live', false, true);
  });
  socket.addEventListener('message', (event) => { if (current(epoch)) onMessage(event.data); });
  socket.addEventListener('close', () => {
    if (!current(epoch)) return;
    streamSocket = null;
    retry();
  });
  socket.addEventListener('error', () => socket.close());
}

function retry() {
  if (retryTimer !== null) return;
  const delay = reconnectDelay(attempt);
  attempt += 1;
  setStatus('disconnected — retrying in ' + Math.round(delay / 1000) + 's', true);
  retryTimer = setTimeout(connect, delay);
}

/**
 * Give up on a socket that has gone quiet and connect afresh, without waiting
 * for its close handshake: a peer that stopped sending frames will not answer
 * a Close frame either, and the browser waits a long time before deciding so.
 */
function abandon() {
  const stale = streamSocket;
  streamSocket = null;
  if (probe) probe.stalls += 1;
  // connect() takes the generation first, so whatever the stale socket does
  // from here on is ignored; then the status says why, over "connecting…".
  void connect();
  setStatus('stalled — reconnecting', true);
  try { stale?.close(); } catch { /* already closing */ }
}

// Once a second: report the last second honestly, and check for a stall.
setInterval(() => {
  const now = performance.now();
  const sinceMessageMs = now - lastMessageAt;
  if (streamSocket?.readyState === WebSocket.OPEN) {
    const status = secondStatus({ ...second, sinceMessageMs });
    if (status) setStatus(status.text, status.bad, status.live);
    if (stalled(lastMessageAt, now)) abandon();
  }
  second = { drawn: 0, bytes: 0 };
}, 1000);

if (!host || !token) setStatus('missing host or token', true);
else void connect();
