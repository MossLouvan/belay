// A deterministic stand-in for the Belay host, just enough of it to drive the
// display renderer: /health, /ws-ticket (single-use, bearer-gated),
// /screen/info, /windows, and a /ws/screen stream in either the binary or the
// legacy JSON framing. Every fault the renderer has to survive is a knob on
// `inject()` rather than something that happens to occur on a real network.
//
// Runs in-process (the Electron driver imports it) or standalone:
//   node test/harness/mock-host.cjs [port]   then   POST /__inject {"kind":...}

const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { resolve } = require('node:path');

// `ws` lives with the real host; the desktop app itself has no dependency on it.
const { WebSocketServer } = require(resolve(__dirname, '..', '..', '..', 'server', 'node_modules', 'ws'));

const BINARY_FRAME = { magic: 0xbf, version: 0x01, header: 24 };
const DEFAULT_TOKEN = 'harness-token';
const TICKET_TTL_MS = 30_000;

/** The compact layout of server/src/frame-codec.ts, version 1. */
function encodeBinaryFrame({ w, h, sw, sh }, jpeg) {
  const header = Buffer.alloc(BINARY_FRAME.header);
  header.writeUInt8(BINARY_FRAME.magic, 0);
  header.writeUInt8(BINARY_FRAME.version, 1);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(w, 4);
  header.writeUInt32BE(h, 8);
  header.writeUInt32BE(sw, 12);
  header.writeUInt32BE(sh, 16);
  header.writeUInt32BE(jpeg.length, 20);
  return Buffer.concat([header, jpeg]);
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((done) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
});

/**
 * @param {object} options
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.token]
 * @param {(index: number) => { w: number, h: number, jpeg: Buffer }} options.frameAt
 *   The picture for frame number `index`; the harness encodes the index in it.
 * @param {() => { w: number, h: number, jpeg: Buffer }} [options.bigFrame]
 *   One frame that is slow to decode, for the slow-decode knob.
 */
function startMockHost({ port = 0, token = DEFAULT_TOKEN, frameAt, bigFrame }) {
  const tickets = new Map();
  const streams = new Set();
  const log = [];
  const state = {
    frameIndex: 0,
    // What the renderer sent us: the control messages, in order.
    received: [],
    // `stalledUntil` pauses the loop; `forceJson` ignores ?bin=1.
    stalledUntil: 0,
    forceJson: false,
    // Reject the next N ws-ticket requests, so the token fallback is exercised.
    refuseTickets: 0,
    fpsOverride: null,
  };

  const authorized = (req) => req.headers.authorization === 'Bearer ' + token;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    log.push(req.method + ' ' + url.pathname);
    if (url.pathname === '/health') return json(res, 200, { ok: true, name: 'mock-host', platform: 'win32' });
    if (url.pathname === '/__inject' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      try { inject(body); } catch (error) { return json(res, 400, { error: String(error.message) }); }
      return json(res, 200, { ok: true });
    }
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/ws-ticket' && req.method === 'POST') {
      if (state.refuseTickets > 0) { state.refuseTickets -= 1; return json(res, 503, { error: 'no tickets' }); }
      const ticket = randomBytes(16).toString('hex');
      tickets.set(ticket, Date.now() + TICKET_TTL_MS);
      return json(res, 200, { ticket, expiresInSec: TICKET_TTL_MS / 1000 });
    }
    if (url.pathname === '/screen/info') return json(res, 200, { screens: [{ index: 0, name: 'Mock', w: 1920, h: 1080, primary: true }] });
    if (url.pathname === '/windows') return json(res, 200, { windows: [] });
    if (url.pathname.startsWith('/input/')) return json(res, 200, { ok: true });
    return json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true });

  const redeem = (ticket) => {
    const expiresAt = tickets.get(ticket);
    tickets.delete(ticket);
    return expiresAt !== undefined && expiresAt > Date.now();
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const ok = url.pathname === '/ws/screen'
      && (url.searchParams.get('ticket') ? redeem(url.searchParams.get('ticket')) : url.searchParams.get('token') === token);
    log.push('UPGRADE ' + url.pathname + (ok ? ' ok' : ' 401'));
    if (!ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => handleScreen(ws, url));
  });

  function sendFrame(ws, frame, binary) {
    if (ws.readyState !== ws.OPEN) return;
    const shape = { w: frame.w, h: frame.h, sw: frame.w, sh: frame.h };
    if (binary && !state.forceJson) ws.send(encodeBinaryFrame(shape, frame.jpeg));
    else ws.send(JSON.stringify({ type: 'frame', ...shape, bytes: frame.jpeg.length, data: frame.jpeg.toString('base64') }));
  }

  function handleScreen(ws, url) {
    const binary = url.searchParams.get('bin') === '1';
    let fps = Math.min(30, Math.max(1, Number(url.searchParams.get('fps')) || 30));
    const stream = { ws, binary, fps: () => state.fpsOverride ?? fps, sent: 0, dead: false };
    streams.add(stream);
    ws.on('message', (raw) => {
      let message = null;
      try { message = JSON.parse(raw.toString()); } catch { /* ignore */ }
      state.received.push(message);
      if (message?.type === 'config' && Number.isFinite(Number(message.fps))) fps = Math.min(30, Math.max(1, Number(message.fps)));
    });
    ws.on('close', () => streams.delete(stream));
    ws.on('error', () => streams.delete(stream));
    const tick = () => {
      if (ws.readyState !== ws.OPEN) return;
      if (!stream.dead && Date.now() >= state.stalledUntil) {
        sendFrame(ws, frameAt(state.frameIndex), binary);
        state.frameIndex += 1;
        stream.sent += 1;
      }
      setTimeout(tick, 1000 / stream.fps());
    };
    tick();
  }

  const forEachStream = (fn) => { for (const stream of streams) fn(stream); };

  /** Fault injection. Each kind is one thing the renderer must live through. */
  function inject(command) {
    const kind = command?.kind;
    switch (kind) {
      case 'burst': {
        const count = Number(command.count) || 60;
        forEachStream((stream) => {
          for (let i = 0; i < count; i += 1) { sendFrame(stream.ws, frameAt(state.frameIndex), stream.binary); state.frameIndex += 1; }
        });
        return;
      }
      case 'big':
        if (!bigFrame) throw new Error('no big frame configured');
        forEachStream((stream) => sendFrame(stream.ws, bigFrame(), stream.binary));
        return;
      case 'close':
        forEachStream((stream) => stream.ws.close(1001, 'injected close'));
        return;
      case 'terminate':
        forEachStream((stream) => stream.ws.terminate());
        return;
      case 'echo':
        forEachStream((stream) => stream.ws.send(JSON.stringify({ type: 'config', w: 1600, q: 55, fps: 30, screen: 0 })));
        return;
      case 'error':
        forEachStream((stream) => stream.ws.send(JSON.stringify({ type: 'error', error: String(command.error ?? 'capture failed') })));
        return;
      case 'garbage':
        forEachStream((stream) => { stream.ws.send(Buffer.from([0xbf, 0x01, 0, 0, 1, 2, 3])); stream.ws.send('not json'); });
        return;
      case 'stall':
        state.stalledUntil = Date.now() + (Number(command.ms) || 30_000);
        return;
      case 'halfOpen':
        // Frames stop and the socket stays open: a host that vanished under a
        // TCP connection nobody has torn down yet. The server also stops
        // reading, so a close handshake the client starts is never answered —
        // the closest an in-process mock gets to a peer that is simply gone.
        // Only the sockets open now; a fresh connection streams normally.
        forEachStream((stream) => { stream.dead = true; stream.ws._socket?.pause(); });
        return;
      case 'reset':
        // Back to a clean stream between scenarios: every knob off, and any
        // socket left for dead torn down so the client's reconnect can land.
        state.stalledUntil = 0;
        state.forceJson = false;
        state.fpsOverride = null;
        state.refuseTickets = 0;
        forEachStream((stream) => { if (stream.dead) stream.ws.terminate(); });
        return;
      case 'resume':
        state.stalledUntil = 0;
        return;
      case 'json':
        state.forceJson = command.on !== false;
        return;
      case 'refuseTickets':
        state.refuseTickets = Number(command.count) || 1;
        return;
      case 'fps':
        state.fpsOverride = command.fps === null ? null : Number(command.fps);
        return;
      default:
        throw new Error('unknown inject kind: ' + String(kind));
    }
  }

  const ready = new Promise((done) => server.listen(port, '127.0.0.1', () => done(server.address().port)));

  return {
    ready,
    token,
    inject,
    state,
    log,
    streams: () => [...streams].map((stream) => ({ binary: stream.binary, sent: stream.sent, dead: stream.dead, open: stream.ws.readyState === stream.ws.OPEN })),
    close: () => new Promise((done) => {
      forEachStream((stream) => stream.ws.terminate());
      wss.close();
      server.close(() => done());
    }),
  };
}

module.exports = { startMockHost, encodeBinaryFrame, DEFAULT_TOKEN };

if (require.main === module) {
  const { solidJpeg } = require('./frames.cjs');
  const host = startMockHost({
    port: Number(process.argv[2]) || 8788,
    frameAt: (index) => solidJpeg(index),
  });
  host.ready.then((port) => process.stdout.write('mock host on http://127.0.0.1:' + port + ' token=' + host.token + '\n'));
}
