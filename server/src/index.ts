// Tether host agent entry point.
//
// HTTP + WebSocket server the phone app talks to. REST for pairing, files,
// system stats and input; WebSockets for the live screen stream and terminal.
// Everything except /pair and /health requires a bearer token issued at pairing.

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { hostname } from 'node:os';
import { URL } from 'node:url';

import {
  loadState, addDevice, findDevice, touchDevice, setHostName, getHostName, listDevices,
  revokeDevice, deviceCount, getHostId, getLabel, setLabel, getPlatform, Device,
} from './state.js';
import { buildAddresses, hasStableAddress } from './addresses.js';
import { ensureCode, currentCode, consumeCode, burnCode, testCodeActive } from './pairing.js';
import { createPairGuard } from './pair-guard.js';
import { resolveStreamParams, StreamParams } from './stream-params.js';
import { native } from './native.js';
import { createTerminal } from './terminal.js';
import { listDir, readTextFile, ROOTS } from './files.js';
import { getStats } from './system.js';
import { VK, MOD_VK, charToVk } from './keys.js';
import { printBanner, buildNativeHint } from './banner.js';

const PORT = Number(process.env.TETHER_PORT || 8787);

/**
 * Browser origins allowed to call the agent.
 *
 * The iOS app is a native client and sends no `Origin` header at all, so none
 * of this applies to it. The only browser that legitimately talks to the agent
 * is the local web build (used by the Playwright suite and for development).
 *
 * A wildcard here is not a small mistake: with `Access-Control-Allow-Origin: *`
 * any page the user happens to visit can script requests against the agent on
 * their own network *and read the responses* — including the token handed back
 * by /pair. That turns a LAN-only weakness into remote takeover from a web ad.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
] as const;

function allowedOrigins(): readonly string[] {
  const configured = process.env.TETHER_ALLOWED_ORIGINS;
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured.split(',').map((o) => o.trim()).filter(Boolean);
}

/**
 * Ceiling on one /input/text request, in UTF-16 code units (what
 * `String.length` counts). Injected text is typed into whatever window
 * currently has OS focus, so an unbounded payload is a real hazard, not just a
 * performance one. The macOS helper enforces the identical number one layer
 * down — see `InputController.maxTextUnits` in server/native/mac/Input.swift —
 * so a caller that reaches the helper by another route still cannot type an
 * unbounded string. Larger text must be chunked by the client.
 */
const MAX_INPUT_TEXT_UNITS = 4096;

/**
 * Send-buffer ceiling for the screen stream, in bytes.
 *
 * Roughly two frames at the default width/quality. Above this the client is
 * consuming slower than the host is producing, so the next frame is dropped
 * instead of queued — the alternative is unbounded growth of the socket's
 * write buffer on a slow link, which is exactly the cellular case.
 */
const MAX_BUFFERED_BYTES = 256 * 1024;

/** Pause when the send buffer is full, before re-checking. */
const FRAME_DROP_BACKOFF_MS = 50;

/** Pause after a capture failure, so a broken helper cannot spin the loop. */
const CAPTURE_ERROR_BACKOFF_MS = 500;

/** How often to rotate and reprint the pairing code while nothing is paired. */
const CODE_REFRESH_INTERVAL_MS = 30_000;

loadState();
if (!getHostName()) setHostName(hostname());

// Only open a pairing window when there is nothing paired yet. Previously this
// ran unconditionally, so every restart of an already-paired host opened a live
// 5-minute code that the banner does not print — an open door nobody could see.
if (deviceCount() === 0) ensureCode();

if (testCodeActive()) {
  console.warn(
    '[pairing] TETHER_TEST_CODE is set: the pairing code is fixed and reusable, ' +
    'and expiry and single-use are both disabled. This is for automated tests only.',
  );
}

const pairGuard = createPairGuard();

const nativeReady = native.available();
if (nativeReady) {
  native.start().catch((e) => console.error('[native] failed to start:', e.message));
} else {
  console.warn(`[native] helper not built — screen/input disabled. To fix, ${buildNativeHint()}`);
}

const app = express();
app.use(cors({ origin: [...allowedOrigins()] }));
app.use(express.json({ limit: '2mb' }));

// ---- auth ----------------------------------------------------------------

interface AuthedRequest extends Request { device?: Device; }

function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string) || '';
  const device = findDevice(token);
  if (!device) { res.status(401).json({ error: 'unauthorized' }); return; }
  touchDevice(device);
  req.device = device;
  next();
}

// ---- public routes -------------------------------------------------------

/**
 * Everything the app needs to recognise and re-find this computer.
 *
 * `id` is the primary key the app stores a computer under — deliberately not
 * the URL, because the URL is the thing that changes. `addresses` is the full
 * set of paths to this host; the app saves all of them and races them at
 * connect time, so it uses fast LAN at home and the tunnel on cellular without
 * the user ever choosing.
 *
 * Returned unauthenticated from /health because the app needs it *before* it
 * has a token. None of it is secret: it is the machine's name and the addresses
 * it already answers on.
 */
function identity() {
  const addresses = buildAddresses(PORT);
  return {
    id: getHostId(),
    label: getLabel(),
    platform: getPlatform(),
    addresses,
    /** False when only LAN addresses exist, i.e. unreachable once you leave. */
    reachableFromAnywhere: hasStableAddress(addresses),
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    name: getHostName(),
    native: nativeReady,
    paired: deviceCount() > 0,
    ...identity(),
  });
});

// The code is only ever shown on the PC (see banner.ts); the phone POSTs a code
// the user read off that screen. Wrong guesses are rate limited per client and
// budgeted per code — see pair-guard.ts for why both limits are needed.
app.post('/pair', (req, res) => {
  const clientId = req.ip ?? 'unknown';

  const decision = pairGuard.check(clientId);
  if (!decision.allowed) {
    res.set('Retry-After', String(decision.retryAfterSec));
    res.status(429).json({
      error: 'too many pairing attempts; wait and try again',
      retryAfterSec: decision.retryAfterSec,
    });
    return;
  }

  const { code, deviceName } = req.body || {};
  if (!consumeCode(String(code || ''))) {
    const outcome = pairGuard.recordFailure(clientId);
    if (outcome.burnCode) {
      // The per-code budget is spent. Burn it rather than let a distributed
      // attempt keep grinding the same code from fresh addresses.
      burnCode();
      pairGuard.resetCodeBudget();
      console.warn('[pairing] too many failed attempts against this code — code invalidated');
    }
    if (outcome.clientLockedOut) {
      console.warn(`[pairing] client ${clientId} locked out after repeated failures`);
    }
    // Deliberately the same message and status whether the code was wrong,
    // expired, or burned — distinguishing them tells an attacker which of the
    // three they hit.
    res.status(400).json({ error: 'invalid or expired pairing code' });
    return;
  }

  pairGuard.recordSuccess(clientId);
  pairGuard.resetCodeBudget();
  const device = addDevice(String(deviceName || 'iPhone'));
  res.json({ token: device.token, name: getHostName() });
});

// ---- authed routes -------------------------------------------------------

app.get('/me', auth, (req: AuthedRequest, res) => {
  res.json({
    device: { name: req.device!.name },
    host: getHostName(),
    native: nativeReady,
    ...identity(),
  });
});

/**
 * Cheap refresh of just the address list.
 *
 * This is how a saved computer self-heals across an IP change: on every
 * successful connect the app re-reads this and updates what it has stored, so
 * a new DHCP lease is learned the next time the phone is on the same network.
 */
app.get('/addresses', auth, (_req, res) => {
  const addresses = buildAddresses(PORT);
  res.json({ addresses, reachableFromAnywhere: hasStableAddress(addresses) });
});

/** Rename this computer, so the app's list reads "MacBook Air", not a hostname. */
const MAX_LABEL_LENGTH = 64;

app.post('/label', auth, (req, res) => {
  const label = String(req.body?.label ?? '').trim();
  if (!label) { res.status(400).json({ error: 'label is required' }); return; }
  if (label.length > MAX_LABEL_LENGTH) {
    res.status(400).json({ error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` });
    return;
  }
  setLabel(label);
  res.json({ ok: true, label: getLabel() });
});

app.get('/system', auth, async (_req, res) => {
  try { res.json(await getStats()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/files/roots', auth, (_req, res) => {
  res.json({ roots: ROOTS });
});

app.get('/files/list', auth, async (req, res) => {
  try { res.json(await listDir(String(req.query.path || ''))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/files/read', auth, async (req, res) => {
  try { res.json(await readTextFile(String(req.query.path || ''))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/screen/info', auth, async (_req, res) => {
  try { res.json(await native.info()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Input. Coordinates arrive normalized 0..1 against the primary screen so the
// phone never needs to know the host resolution.
app.post('/input/click', auth, async (req, res) => {
  try {
    const { x, y, button = 'left', double = false } = req.body || {};
    await native.click(button, x, y, double);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/input/move', auth, async (req, res) => {
  try { await native.move(req.body.x, req.body.y); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/input/scroll', auth, async (req, res) => {
  try {
    const { dy = 0, dx = 0 } = req.body || {};
    await native.scroll(dy, dx);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/input/drag', auth, async (req, res) => {
  try {
    const { x1, y1, x2, y2, button = 'left' } = req.body || {};
    await native.down(button, x1, y1);
    await native.move(x2, y2);
    await native.up(button, x2, y2);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/input/text', auth, async (req, res) => {
  try {
    const text = String(req.body?.text ?? '');
    if (text.length > MAX_INPUT_TEXT_UNITS) {
      res.status(413).json({
        error: `text is ${text.length} characters, over the ${MAX_INPUT_TEXT_UNITS} limit for one request; send it in chunks`,
        limit: MAX_INPUT_TEXT_UNITS,
        length: text.length,
      });
      return;
    }
    await native.text(text);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// A named key (enter, tab, arrows...) optionally with modifiers, or a single
// character that should compose with modifiers (ctrl+c). Falls back to text.
app.post('/input/key', auth, async (req, res) => {
  try {
    const { key, mods = [] } = req.body || {};
    const name = String(key || '').toLowerCase();
    const modVks = (mods as string[]).map((m) => MOD_VK[m.toLowerCase()]).filter((v): v is number => !!v);
    let vk: number | null = VK[name] ?? null;
    if (vk === null) vk = charToVk(String(key || ''));
    if (vk !== null) {
      await native.key(vk, modVks);
    } else if (key) {
      await native.text(String(key));
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/devices', auth, (_req, res) => res.json({ devices: listDevices() }));
// Revoking matches on a token prefix. An empty prefix is a prefix of every
// token, so accepting one would let a single request unpair every device;
// require a prefix long enough to identify one deliberately.
const MIN_REVOKE_PREFIX = 4;

app.post('/devices/revoke', auth, (req, res) => {
  const prefix = String(req.body?.prefix || '').trim();
  if (prefix.length < MIN_REVOKE_PREFIX) {
    res.status(400).json({ error: `prefix must be at least ${MIN_REVOKE_PREFIX} characters` });
    return;
  }
  res.json({ ok: revokeDevice(prefix) });
});

// ---- server + websockets -------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// One handler per WS path. Auth happens once here at the upgrade.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('token') || '';
  const device = findDevice(token);
  if (!device) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  touchDevice(device);

  if (url.pathname === '/ws/screen') {
    wss.handleUpgrade(req, socket, head, (ws) => handleScreen(ws, url));
  } else if (url.pathname === '/ws/terminal') {
    // handleTerminal is async; an unhandled rejection here would exit the
    // process under Node's default policy, so the promise is explicitly caught.
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleTerminal(ws, url).catch((e: unknown) => {
        console.error('[terminal] session failed:', messageOf(e));
        if (ws.readyState === ws.OPEN) ws.close();
      });
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// Screen stream: capture-encode-send in a self-scheduling loop. The next frame
// is only requested after the previous one is sent, so a slow link naturally
// lowers the frame rate instead of piling up a backlog.
function handleScreen(ws: WebSocket, url: URL) {
  let alive = true;
  // Query string and control message go through the same validation. Both are
  // untrusted, and only clamping one of them is how `?fps=100000` and
  // `{"fps":"abc"}` each turned into an uncapped capture loop.
  let params: StreamParams = resolveStreamParams({
    w: url.searchParams.get('w'),
    q: url.searchParams.get('q'),
    fps: url.searchParams.get('fps'),
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === 'config') params = resolveStreamParams(msg, params);
    } catch { /* ignore malformed control messages */ }
  });
  ws.on('close', () => { alive = false; });
  ws.on('error', () => { alive = false; });

  const loop = async () => {
    while (alive && ws.readyState === ws.OPEN) {
      const started = Date.now();
      try {
        const frame = await native.capture(params.width, params.quality, false);
        if (!alive) break;
        // Backpressure: ws.send() returns immediately and buffers, so without
        // this check a link slower than the capture rate grows the send buffer
        // without bound until the host runs out of memory. Dropping the frame
        // is correct for a live stream — a stale frame has no value.
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          await sleep(FRAME_DROP_BACKOFF_MS);
          continue;
        }
        ws.send(JSON.stringify({ type: 'frame', ...frame }));
      } catch (e: unknown) {
        if (alive && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'error', error: messageOf(e) }));
        }
        await sleep(CAPTURE_ERROR_BACKOFF_MS);
      }
      const budget = 1000 / params.fps;
      const elapsed = Date.now() - started;
      if (elapsed < budget) await sleep(budget - elapsed);
    }
  };
  void loop().catch((e: unknown) => console.error('[screen] stream loop failed:', messageOf(e)));
}

async function handleTerminal(ws: WebSocket, url: URL) {
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;

  // Closed-during-startup guard. `createTerminal` awaits a dynamic import of
  // node-pty and then a process spawn — tens of milliseconds during which the
  // client can disconnect. Registering 'close' only after that await meant the
  // event fired before the handler existed and the shell was never killed, so a
  // connect/disconnect loop orphaned one login shell per iteration.
  let closed = false;
  const markClosed = () => { closed = true; };
  ws.on('close', markClosed);
  // Without an 'error' listener, ws emits on an EventEmitter with no handler,
  // which throws and takes down the entire host agent — every other session
  // with it. A TCP reset from one phone is enough.
  ws.on('error', markClosed);

  let term: Awaited<ReturnType<typeof createTerminal>>;
  try {
    term = await createTerminal(cols, rows);
  } catch (e: unknown) {
    if (!closed && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', error: messageOf(e) }));
      ws.close();
    }
    return;
  }

  // The socket went away while the shell was starting: kill it immediately
  // rather than leaking a process nobody is attached to.
  if (closed || ws.readyState !== ws.OPEN) { term.kill(); return; }

  ws.send(JSON.stringify({ type: 'ready', mode: term.mode }));
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit' }));
    ws.close();
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'data') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(msg.cols, msg.rows);
    } catch { /* ignore */ }
  });
  ws.on('close', () => term.kill());
  ws.on('error', () => term.kill());
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Narrow an unknown thrown value to a message without assuming it is an Error. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- boot ----------------------------------------------------------------

server.listen(PORT, () => {
  printBanner({
    hostName: getHostName(),
    port: PORT,
    nativeReady,
    pairingCode: currentCode(),
    deviceCount: deviceCount(),
  });
});

// While no device is paired, keep a valid pairing code alive and reprint it
// whenever it rotates, so the PC always shows a code that actually works even
// if the user takes more than the 5-minute window to pair.
let lastPrintedCode = currentCode()?.code || '';
setInterval(() => {
  if (deviceCount() > 0) return;
  ensureCode();
  const c = currentCode();
  if (c && c.code !== lastPrintedCode) {
    lastPrintedCode = c.code;
    // A rotated code gets a fresh failure budget; the old code's budget died
    // with it.
    pairGuard.resetCodeBudget();
    console.log(`  New pairing code: ${c.code}   (enter this in the Tether app)`);
  }
}, CODE_REFRESH_INTERVAL_MS).unref();

// A host agent that exits on an unexpected rejection is a host agent you cannot
// reach from your phone. Log and keep serving — every request path already has
// its own error handling, so a stray rejection is a bug to diagnose, not a
// reason to drop every other session.
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[fatal] unhandled rejection:', messageOf(reason));
});
process.on('uncaughtException', (error: unknown) => {
  console.error('[fatal] uncaught exception:', messageOf(error));
});

process.on('SIGINT', () => { native.stop(); process.exit(0); });
process.on('SIGTERM', () => { native.stop(); process.exit(0); });
