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

import { loadState, addDevice, findDevice, touchDevice, setHostName, getHostName, listDevices, revokeDevice, Device } from './state.js';
import { ensureCode, currentCode, consumeCode } from './pairing.js';
import { native } from './native.js';
import { createTerminal } from './terminal.js';
import { listDir, readTextFile, ROOTS } from './files.js';
import { getStats } from './system.js';
import { VK, MOD_VK, charToVk } from './keys.js';
import { printBanner, buildNativeHint } from './banner.js';

const PORT = Number(process.env.TETHER_PORT || 8787);

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

loadState();
if (!getHostName()) setHostName(hostname());
ensureCode();

const nativeReady = native.available();
if (nativeReady) {
  native.start().catch((e) => console.error('[native] failed to start:', e.message));
} else {
  console.warn(`[native] helper not built — screen/input disabled. To fix, ${buildNativeHint()}`);
}

const app = express();
app.use(cors());
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: getHostName(), native: nativeReady, paired: listDevices().length > 0 });
});

// The PC-side pairing display (see /pair-status) is what shows the code; the
// phone only ever POSTs a code it was told out of band.
app.post('/pair', (req, res) => {
  const { code, deviceName } = req.body || {};
  if (!consumeCode(String(code || ''))) {
    res.status(400).json({ error: 'invalid or expired pairing code' });
    return;
  }
  const device = addDevice(String(deviceName || 'iPhone'));
  res.json({ token: device.token, name: getHostName() });
});

// ---- authed routes -------------------------------------------------------

app.get('/me', auth, (req: AuthedRequest, res) => {
  res.json({ device: { name: req.device!.name }, host: getHostName(), native: nativeReady });
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
app.post('/devices/revoke', auth, (req, res) => {
  const ok = revokeDevice(String(req.body.prefix || ''));
  res.json({ ok });
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
    wss.handleUpgrade(req, socket, head, (ws) => handleTerminal(ws, url));
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
  let width = Number(url.searchParams.get('w')) || 1024;
  let quality = Number(url.searchParams.get('q')) || 50;
  let fps = Number(url.searchParams.get('fps')) || 12;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'config') {
        if (msg.w) width = Math.max(240, Math.min(1920, msg.w));
        if (msg.q) quality = Math.max(20, Math.min(90, msg.q));
        if (msg.fps) fps = Math.max(1, Math.min(30, msg.fps));
      }
    } catch { /* ignore malformed control messages */ }
  });
  ws.on('close', () => { alive = false; });
  ws.on('error', () => { alive = false; });

  const loop = async () => {
    while (alive && ws.readyState === ws.OPEN) {
      const started = Date.now();
      try {
        const frame = await native.capture(width, quality, false);
        if (!alive) break;
        ws.send(JSON.stringify({ type: 'frame', ...frame }));
      } catch (e: any) {
        if (alive) ws.send(JSON.stringify({ type: 'error', error: e.message }));
        await sleep(500);
      }
      const budget = 1000 / fps;
      const elapsed = Date.now() - started;
      if (elapsed < budget) await sleep(budget - elapsed);
    }
  };
  loop();
}

async function handleTerminal(ws: WebSocket, url: URL) {
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;
  const term = await createTerminal(cols, rows);
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
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ---- boot ----------------------------------------------------------------

server.listen(PORT, () => {
  printBanner({
    hostName: getHostName(),
    port: PORT,
    nativeReady,
    pairingCode: currentCode(),
    deviceCount: listDevices().length,
  });
});

// While no device is paired, keep a valid pairing code alive and reprint it
// whenever it rotates, so the PC always shows a code that actually works even
// if the user takes more than the 5-minute window to pair.
let lastPrintedCode = currentCode()?.code || '';
setInterval(() => {
  if (listDevices().length > 0) return;
  ensureCode();
  const c = currentCode();
  if (c && c.code !== lastPrintedCode) {
    lastPrintedCode = c.code;
    console.log(`  New pairing code: ${c.code}   (enter this in the Tether app)`);
  }
}, 30000).unref();

process.on('SIGINT', () => { native.stop(); process.exit(0); });
process.on('SIGTERM', () => { native.stop(); process.exit(0); });
