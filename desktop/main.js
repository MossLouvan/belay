// Tether desktop client — main process.
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

import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { clearSession, readSession, writeSession } from './src/session.js';
import { fitWindow } from './src/displays.js';
import { cascadeOffset, initialSize, windowLabel } from './src/windows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .cjs, not .js: package.json sets "type": "module", and Electron loads a
// sandboxed preload script as CommonJS. The extension is what keeps those two
// facts from contradicting each other.
const preload = join(__dirname, 'preload.cjs');

/** Every display window, so a "disconnect" can close them all at once. */
const displayWindows = new Set();

function createConnectWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 640,
    title: 'Tether',
    backgroundColor: '#101014',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(join(__dirname, 'renderer', 'connect.html'));
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
    backgroundColor: '#000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (display.w > 0 && display.h > 0) win.setAspectRatio(display.w / display.h);

  const params = new URLSearchParams({
    host: session.host,
    token: session.token,
    screen: String(display.index),
    name: display.name,
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
    backgroundColor: '#000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const params = new URLSearchParams({
    host: session.host,
    token: session.token,
    window: remote.id,
    name: windowLabel(remote),
  });
  win.loadFile(join(__dirname, 'renderer', 'seamless.html'), { search: params.toString() });

  displayWindows.add(win);
  win.on('closed', () => displayWindows.delete(win));
  return win;
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');

  ipcMain.handle('session:read', () => readSession(userData));
  ipcMain.handle('session:write', (_event, session) => {
    writeSession(userData, {
      host: String(session?.host ?? ''),
      token: String(session?.token ?? ''),
      label: String(session?.label ?? ''),
    });
    return true;
  });
  ipcMain.handle('session:clear', () => {
    // Closing the display windows is part of forgetting the host: they hold a
    // live socket authenticated with the token being discarded, and leaving one
    // open would keep streaming a computer the app says it is no longer paired
    // with.
    for (const win of [...displayWindows]) win.close();
    clearSession(userData);
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

  createConnectWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createConnectWindow();
  });
});

// Windows and Linux quit with the last window; macOS keeps the app running,
// which is the platform convention and lets the dock icon reopen the connect
// window without re-pairing.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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
