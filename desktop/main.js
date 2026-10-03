// Belay desktop client — main process.
//
// Two window kinds:
//   connect   pairs with a host and lists its displays
//   display   one remote display, streamed into a resizable desktop window
//
// A display window is a separate BrowserWindow rather than a view inside the
// connect window, because that is the whole point of a desktop client: the
// remote screen becomes a window you alt-tab to, snap beside a local app, or
// throw onto a second monitor. It is also the shape the seamless per-window
// mode needs later — that feature is this, once per remote window.
//
// The renderer runs with contextIsolation on and no Node integration; every
// privileged operation (reading the saved token, opening a window) crosses IPC
// through preload.js. The renderer does talk to the host directly over HTTP and
// WebSocket, which is unprivileged network access and keeps the streaming path
// out of the main process, where a slow frame would block window management.

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, safeStorage, screen, session, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import { clearSession, keymapModeOf, migrateLegacySession, readSession, writeSession } from './src/session.js';
import { fitWindow } from './src/displays.js';
import { cascadeOffset, initialSize, windowLabel } from './src/windows.js';
import { GROUND } from './src/ground.js';
import { LOOK_CHOICES, normalizeMode, resolveLook } from './src/look.js';
import { createPinStore, probeFingerprint } from './src/pins.js';
import { startHost } from './host.js';

// The certificate pins Chromium consults for every TLS connection the
// renderer makes (src/pins.js). Loaded from the saved session at startup and
// updated by pairing; a pinned host that presents any other certificate is
// refused before a byte of the token leaves this machine.
const pins = createPinStore();

const __dirname = dirname(fileURLToPath(import.meta.url));

// One Belay per user: a second launch (double-clicking the .app again while
// it sits in the menu bar) hands over to the first copy, which shows its
// window. Without this the second copy would find its own port busy and
// tell the user someone else is running Belay.
if (!app.requestSingleInstanceLock()) app.quit();

// Keep the controller's 4 ms hidden-window timer running. Unlike disabling
// backgroundThrottling, this preserves visibilityState and the rAF fallback.
app.commandLine.appendSwitch('disable-background-timer-throttling');
// .cjs, not .js: package.json sets "type": "module", and Electron loads a
// sandboxed preload script as CommonJS. The extension is what keeps those two
// facts from contradicting each other.
const preload = join(__dirname, 'preload.cjs');

/** Every display window, so a "disconnect" can close them all at once. */
const displayWindows = new Set();

// ── appearance: Harbour, Night, Current or Fieldwork (src/look.js) ────────
// One choice for every window, stored beside the session. Explicit looks pin
// nativeTheme too, so the title bar, menus and form controls match the page;
// 'system' (the default) leaves the OS in charge and Harbour follows it into
// Night. Every window hears a change at once through 'look:changed'.
const LOOK_FILE = 'appearance.json';
let lookMode = 'system';
const lookListeners = new Set();

const currentLook = () => resolveLook(lookMode, nativeTheme.shouldUseDarkColors);

function broadcastLook() {
  const look = currentLook();
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('look:changed', look);
  for (const listener of lookListeners) listener(look);
}

function setLook(mode, userData) {
  lookMode = normalizeMode(mode);
  nativeTheme.themeSource = lookMode === 'system' ? 'system' : currentLook().scheme;
  if (userData) {
    try { writeFileSync(join(userData, LOOK_FILE), JSON.stringify({ mode: lookMode })); } catch (e) {
      console.error(`[look] could not save the appearance: ${e?.message ?? e}`);
    }
  }
  broadcastLook();
}

function loadLook(userData) {
  try { lookMode = normalizeMode(JSON.parse(readFileSync(join(userData, LOOK_FILE), 'utf8')).mode); } catch { /* first run: system */ }
  nativeTheme.themeSource = lookMode === 'system' ? 'system' : currentLook().scheme;
}

// The ground Electron paints before the page's CSS loads, so the first frame
// is already the chosen look rather than a flash of another one. `machine`
// is the panel colour a stream sits on — dark in every look.
const pageGround = () => GROUND[currentLook().name];

function createConnectWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 480,
    minHeight: 420,
    title: 'Belay',
    backgroundColor: pageGround(),
    // Windows/Linux: no File/Edit/View bar over the page; Alt shows it, and
    // its accelerators (copy, paste) work either way. Ignored on macOS.
    autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(join(__dirname, 'renderer', 'connect.html'));

  // A desktop text field is expected to answer a right-click. Attached to the
  // connect window alone: in display and seamless windows the right button
  // belongs to the remote desktop, and a local menu there would steal it.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    Menu.buildFromTemplate(
      params.isEditable
        ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
        : [{ role: 'copy' }],
    ).popup();
  });
  return win;
}

/**
 * Open one remote display in its own window.
 *
 * Sized to the remote display's aspect ratio and locked to it: a window whose
 * shape differs from the stream letterboxes it, and every pointer coordinate
 * then has to be un-letterboxed before it means anything to the host. Keeping
 * the frame the right shape means the renderer's mapping is just a scale.
 */
function createDisplayWindow(session, display) {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const { width, height } = fitWindow(display, workArea);
  const win = new BrowserWindow({
    width,
    height,
    title: `${session.label || session.host} · ${display.name}`,
    backgroundColor: GROUND.machine,
    autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (display.w > 0 && display.h > 0) win.setAspectRatio(display.w / display.h);

  const params = new URLSearchParams({
    host: session.host,
    token: session.token,
    screen: String(display.index),
    name: display.name,
    // The host's platform and the chosen modifier mode ride the URL so the
    // renderer can build its modifier map without a round trip: the first
    // keystroke must already mean the right thing.
    platform: session.platform || '',
    keymap: keymapModeOf(session.keymap),
  });
  win.loadFile(join(__dirname, 'renderer', 'display.html'), { search: params.toString() });

  displayWindows.add(win);
  win.on('closed', () => displayWindows.delete(win));
  return win;
}

/**
 * Open one *window* of the host as a window of this desktop.
 *
 * Frameless on purpose: the point of seamless mode is that the remote window's
 * own title bar is in the stream, so a local title bar on top of it would give
 * every window two. `-webkit-app-region: drag` in the renderer makes the remote
 * title bar drag the local window, which is what a user will try first.
 *
 * The size is the remote window's own, fitted to this screen and never
 * upscaled, and a batch cascades so twelve windows do not land on one pixel.
 */
function createSeamlessWindow(session, remote, index = 0) {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const { width, height } = initialSize(remote, workArea);
  const offset = cascadeOffset(index);

  const win = new BrowserWindow({
    width,
    height,
    x: 60 + offset.x,
    y: 60 + offset.y,
    title: windowLabel(remote),
    frame: false,
    backgroundColor: GROUND.machine,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const params = new URLSearchParams({
    host: session.host,
    token: session.token,
    window: remote.id,
    name: windowLabel(remote),
    platform: session.platform || '',
    keymap: keymapModeOf(session.keymap),
  });
  win.loadFile(join(__dirname, 'renderer', 'seamless.html'), { search: params.toString() });

  displayWindows.add(win);
  win.on('closed', () => displayWindows.delete(win));
  return win;
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');

  loadLook(userData);
  // Sync on purpose: renderer/look.js applies the look in <head>, before the
  // first paint, and a promise would resolve after it.
  ipcMain.on('look:get', (event) => { event.returnValue = currentLook(); });
  ipcMain.handle('look:set', (_event, mode) => { setLook(mode, userData); return currentLook(); });
  nativeTheme.on('updated', () => { if (lookMode === 'system') broadcastLook(); });

  session.defaultSession.setCertificateVerifyProc((request, callback) => callback(pins.decide(request)));
  const saved = readSession(userData, safeStorage);
  if (saved.host && saved.fingerprint) pins.pin(saved.host, saved.fingerprint);

  ipcMain.handle('tls:probe', (_event, origin) => probeFingerprint(String(origin ?? '')));
  ipcMain.handle('tls:pin', (_event, { origin, fingerprint }) => {
    if (!/^[0-9a-f]{64}$/i.test(String(fingerprint ?? ''))) throw new Error('not a SHA-256 fingerprint');
    pins.pin(String(origin), String(fingerprint));
    return true;
  });
  // The rename moved the userData directory; pick up the session the
  // pre-rename build saved so pairing survives the update (see session.js).
  migrateLegacySession(userData, join(app.getPath('appData'), 'tether-desktop'), safeStorage);

  // safeStorage is main-process only: the renderer gets the decrypted
  // session through these same channels and never touches the vault.
  ipcMain.handle('session:read', () => readSession(userData, safeStorage));
  ipcMain.handle('session:write', (_event, saved) => {
    writeSession(userData, {
      host: String(saved?.host ?? ''),
      token: String(saved?.token ?? ''),
      label: String(saved?.label ?? ''),
      platform: String(saved?.platform ?? ''),
      keymap: keymapModeOf(saved?.keymap),
      fingerprint: String(saved?.fingerprint ?? ''),
      deviceId: String(saved?.deviceId ?? ''),
      secret: String(saved?.secret ?? ''),
    }, safeStorage);
    return true;
  });
  ipcMain.handle('session:clear', () => {
    // Closing the display windows is part of forgetting the host: they hold a
    // live socket authenticated with the token being discarded, and leaving one
    // open would keep streaming a computer the app says it is no longer paired
    // with.
    for (const win of [...displayWindows]) win.close();
    clearSession(userData);
    pins.clear();
    return true;
  });
  ipcMain.handle('display:open', (_event, { session, display }) => {
    createDisplayWindow(session, display);
    return true;
  });

  ipcMain.handle('window:open', (_event, { session, windows }) => {
    const list = Array.isArray(windows) ? windows : [windows];
    list.forEach((remote, index) => createSeamlessWindow(session, remote, index));
    return list.length;
  });

  // Resizing is driven by the stream: the remote window's rectangle arrives
  // with every frame, and the renderer asks for the local window to match. It
  // comes through the main process because a renderer cannot resize its own
  // BrowserWindow without nodeIntegration, which stays off.
  ipcMain.handle('window:resize', (event, { width, height }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 160 || h < 120) return false;
    // Guarded against a resize storm: setting a size the window already has
    // still emits a resize event, which the renderer would answer with another
    // request.
    const [currentW, currentH] = win.getSize();
    if (Math.abs(currentW - w) <= 2 && Math.abs(currentH - h) <= 2) return false;
    win.setSize(w, h);
    return true;
  });

  ipcMain.handle('window:title', (event, title) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.setTitle(String(title || '').slice(0, 120));
    return true;
  });

  // A seamless window whose remote window closed has nothing left to show.
  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return true;
  });

  // The host role: menu bar item, QR window, permissions, login item. The
  // viewer (connect window) stays one menu entry away — a Mac can still open
  // another computer's displays as windows, host or not.
  const look = Object.freeze({
    choices: LOOK_CHOICES,
    current: currentLook,
    ground: pageGround,
    set: (mode) => setLook(mode, userData),
    subscribe: (listener) => lookListeners.add(listener),
  });
  const openHostWindow = startHost({ openViewer: createConnectWindow, look });
  app.on('second-instance', () => openHostWindow());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openHostWindow();
  });

  if (app.isPackaged) {
    // GitHub Releases feed (latest-mac.yml / latest.yml). Needs a signed build
    // to install on macOS; an unsigned one logs the refusal and carries on.
    import('electron-updater')
      .then(({ default: updater }) => updater.autoUpdater.checkForUpdatesAndNotify())
      .catch((e) => console.error(`[updater] ${e?.message ?? e}`));
  }
});

// Closing the last window never quits: the host keeps serving from the menu
// bar on every platform. Quit lives in the tray menu.
app.on('window-all-closed', () => {});

// A renderer must never navigate itself somewhere else or spawn a window we did
// not create: both are how a hostile page reached through the host's HTTP
// responses would escape the two files this app is supposed to be.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
});
