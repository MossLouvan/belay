// End-to-end smoke check for the seamless renderer: point it at a live host and
// a window id, and it reports what the client actually did — whether the socket
// connected, what size the canvas reached (i.e. whether frames decoded), any
// console errors, and a JPEG of the pixels it drew.
//
// This is what unit tests cannot show: preload wiring, the ws-ticket round trip,
// the origin the host sees, JPEG decode, and the resize IPC.
//
// Run it from OUTSIDE the app directory, because Electron resolves an app root
// from the script path — a script inside desktop/ makes it load package.json's
// `main` (the real client) instead of this file. Hence the copy-out, the
// explicit appDir, and the `--` before the arguments (without it Electron reads
// the first one as a second app path and exits):
//
//   cp test/smoke.cjs /tmp/smoke.cjs
//   node_modules/electron/dist/electron.exe /tmp/smoke.cjs -- \
//     "$PWD" http://127.0.0.1:8787 <token> <windowId> /tmp/out.jpg
//
// Results land in <out>.json, not stdout: Electron on Windows detaches from the
// parent console and console.log from the main process goes nowhere.

const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [appDir, host, token, windowId, outPath] = process.argv.slice(2).filter((a) => a !== '--');
const steps = [];
const dump = (extra) => { try { writeFileSync(outPath + '.json', JSON.stringify({ steps, ...extra }, null, 2)); } catch (e) {} };
dump({ boot: process.argv });
process.on('uncaughtException', (e) => { dump({ fatal: e.message, stack: e.stack }); app.exit(1); });

app.whenReady().then(async () => {
  try {
    steps.push('ready'); dump({});
    const win = new BrowserWindow({
      width: 900, height: 560, frame: false, show: true, backgroundColor: '#000',
      webPreferences: { preload: join(appDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    steps.push('window'); dump({});
    const errors = [];
    win.webContents.on('console-message', (e) => { if (String(e.message || '').trim()) errors.push(String(e.message)); });
    const params = new URLSearchParams({ host, token, window: windowId, name: 'Smoke test' });
    await win.loadFile(join(appDir, 'renderer', 'seamless.html'), { search: params.toString() });
    steps.push('loaded'); dump({});
    await new Promise((r) => setTimeout(r, 6000));
    const probe = await win.webContents.executeJavaScript(
      'JSON.stringify({ status: document.getElementById("status").textContent, canvas: [document.getElementById("screen").width, document.getElementById("screen").height], title: document.title })'
    );
    steps.push('probed');
    // The canvas itself, not capturePage: an offscreen or occluded window
    // captures as empty, but the canvas holds the decoded frame either way.
    const dataUrl = await win.webContents.executeJavaScript(
      'document.getElementById("screen").toDataURL("image/jpeg", 0.8)'
    );
    writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    dump({ probe: JSON.parse(probe), size: win.getSize(), errors });
    app.quit();
  } catch (e) { dump({ fatal: e.message, stack: e.stack }); app.quit(); }
});
