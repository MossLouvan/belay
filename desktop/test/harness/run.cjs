// Drives the real display renderer (renderer/display.html, preload and all)
// in a hidden Electron window against the mock host, injects every fault the
// mock knows, and asserts frames keep reaching the canvas after each one.
//
//   npm run test:harness                (from desktop/)
//
// Electron is pointed at this directory, whose package.json names this file as
// main, so the app root is the harness and not the client. Results go to
// stdout as one line per scenario and a JSON summary; the exit code is the
// verdict. A scenario can be selected with HARNESS_ONLY=<name>.

const { app, BrowserWindow } = require('electron');
const { join, resolve } = require('node:path');
const { startMockHost } = require('./mock-host.cjs');
const { solidJpeg, frameIndexOf } = require('./frames.cjs');
const { scenarios } = require('./scenarios.cjs');

const appDir = resolve(__dirname, '..', '..');
const BIG = { w: 3840, h: 2160 };
// HARNESS_FRAME=1600x900 streams frames the size a real host sends.
const FRAME = (() => {
  const match = /^(\d+)x(\d+)$/.exec(process.env.HARNESS_FRAME ?? '');
  return match ? { w: Number(match[1]), h: Number(match[2]) } : { w: 640, h: 360 };
})();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Read the renderer's counters and the frame index of the drawn pixel. */
async function probe(win) {
  const raw = await win.webContents.executeJavaScript(`(() => {
    const s = window.__belayStats || {};
    const canvas = document.getElementById('screen');
    let pixel = null;
    try {
      const d = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
      pixel = { r: d[0], g: d[1], b: d[2] };
    } catch {}
    return JSON.stringify({
      received: s.received || 0, drawn: s.drawn || 0, stalls: s.stalls || 0, reconnects: s.reconnects || 0,
      dropped: s.dropped || 0, canvas: [canvas.width, canvas.height], pixel,
      status: document.getElementById('stats').textContent,
      statusClass: document.getElementById('stats').className,
    });
  })()`);
  const snapshot = JSON.parse(raw);
  return { ...snapshot, frame: snapshot.pixel ? frameIndexOf(snapshot.pixel) : -1 };
}

/** Wait until `predicate(snapshot)` holds, or give up after `timeoutMs`. */
async function waitFor(win, predicate, timeoutMs, everyMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let last = await probe(win);
  while (!predicate(last)) {
    if (Date.now() > deadline) return { ok: false, last };
    await sleep(everyMs);
    last = await probe(win);
  }
  return { ok: true, last };
}

async function main() {
  const host = startMockHost({
    frameAt: (index) => solidJpeg(index, FRAME.w, FRAME.h),
    bigFrame: () => solidJpeg(4000, BIG.w, BIG.h),
  });
  const port = await host.ready;
  const consoleLines = [];
  const win = new BrowserWindow({
    width: 960, height: 540, show: false, backgroundColor: '#000',
    webPreferences: { preload: join(appDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.on('console-message', (event) => {
    const text = String(event.message ?? '').trim();
    if (text) consoleLines.push(text);
  });
  const params = new URLSearchParams({
    host: 'http://127.0.0.1:' + port, token: host.token, screen: '0', name: 'Harness', platform: 'win32', keymap: 'remap', stats: '1',
  });
  await win.loadFile(join(appDir, 'renderer', 'display.html'), { search: params.toString() });

  // Every scenario starts from a stream that is up and drawing.
  const first = await waitFor(win, (s) => s.drawn > 0, 15000);
  if (!first.ok) {
    process.stdout.write('FAIL the stream never started: ' + JSON.stringify(first.last) + '\n');
    await host.close();
    app.exit(1);
    return;
  }

  const only = process.env.HARNESS_ONLY;
  const results = [];
  const context = { win, host, frame: FRAME, probe: () => probe(win), waitFor: (p, t) => waitFor(win, p, t), sleep };
  for (const scenario of scenarios) {
    if (only && scenario.name !== only) continue;
    const started = Date.now();
    let outcome;
    try {
      outcome = await scenario.run(context);
    } catch (error) {
      outcome = { ok: false, detail: 'threw: ' + String(error?.stack ?? error) };
    }
    const line = { name: scenario.name, ok: outcome.ok, ms: Date.now() - started, detail: outcome.detail ?? '' };
    results.push(line);
    process.stdout.write((line.ok ? 'PASS ' : 'FAIL ') + line.name + ' (' + line.ms + 'ms) ' + line.detail + '\n');
    // Scenarios are independent: a fault one leaves behind must not decide the next.
    host.inject({ kind: 'reset' });
    await waitFor(win, (s) => s.drawn > 0 && host.streams().some((stream) => stream.open && !stream.dead), 15000);
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, console: consoleLines.slice(0, 40) }, null, 2) + '\n');
  await host.close();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  process.stderr.write('harness crashed: ' + String(error?.stack ?? error) + '\n');
  app.exit(2);
});
