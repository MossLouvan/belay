// The host role of Belay.app: run the host agent, show it in the menu bar,
// draw the pairing QR, walk through the macOS permissions, start at login.
//
// The agent (server/, compiled to host/dist) runs as a utilityProcess child,
// not in this process. It is a 2,000-line script with top-level effects —
// it listens, installs its own SIGINT/uncaughtException policy and calls
// process.exit on shutdown — so hosting it in the main process would hand
// those decisions to the whole app. As a child it keeps its own process the
// way `npx belay-host` gives it one, a crash restarts it without taking the
// window down, and the parent port carries the pairing link out and the
// login-item answer back (server/src/host-ipc.ts). TCC still attributes the
// helper it spawns to this bundle, which is the whole point of shipping an app.

import {
  app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, nativeTheme, shell, systemPreferences, Tray, utilityProcess,
} from 'electron';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { GROUND } from './src/ground.js';
import { PHONE_APP_URL, loginItemAfterHealth, parsePairing, qrSvg, readHealth, statusLine } from './src/host-status.js';
import { launchAgentInstalled, stopLaunchAgent } from './src/launch-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8787;
const HEALTH_POLL_MS = 4_000;
const BUSY_RETRY_MS = 10_000;
const RESTART_DELAY_MS = 3_000;
const PREFS_FILE = 'host-prefs.json';
const STATE_FILE = 'belay-state.json';
const LOG_FILE = 'host.log';
const SETTINGS_PANE = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

/** The staged host (Resources/host) when packaged; the sibling server/ in a checkout. */
export function hostDir() {
  return app.isPackaged ? join(process.resourcesPath, 'host') : resolve(__dirname, '..', 'server');
}

/**
 * A QR matrix from the encoder the host ships (qrcode-terminal, staged under
 * host/dist/node_modules; server/node_modules in a checkout) — the same one
 * the pairing QR comes from, so nothing new to bundle.
 */
function qrModules(text) {
  try {
    const require = createRequire(join(hostDir(), 'dist', 'index.js'));
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
    const qr = new QRCode(-1, level.L);
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => Boolean(qr.isDark(r, c))));
  } catch (e) {
    console.error(`[host] no QR encoder for ${text}: ${e?.message ?? e}`);
    return [];
  }
}

function readPrefs(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function permissions() {
  if (process.platform !== 'darwin') return { supported: false, screen: true, accessibility: true };
  return {
    supported: true,
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

/**
 * Start the host role. `openViewer` opens the existing connect window, so the
 * menu can offer both roles. Returns the window opener for `activate`.
 */
export function startHost({ openViewer }) {
  const userData = app.getPath('userData');
  const prefsFile = join(userData, PREFS_FILE);
  const port = Number(process.env.BELAY_PORT || process.env.TETHER_PORT || DEFAULT_PORT);
  let prefs = readPrefs(prefsFile);
  let child = null;
  let quitting = false;
  let hostWindow = null;
  let tray = null;
  let state = { phase: 'starting', port, devices: 0, native: false, paired: false, pairing: null, claim: null, perms: permissions() };
  const phoneAppSvg = qrSvg(qrModules(PHONE_APP_URL));

  const savePrefs = (next) => {
    if (next === prefs) return;
    prefs = next;
    writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
    app.setLoginItemSettings({ openAtLogin: prefs.openAtLogin === true, openAsHidden: true });
  };

  const snapshot = () => ({
    ...state,
    // Live, not cached: the user flips these in System Settings while we watch.
    perms: permissions(),
    // Unlinked, the account claim QR is the way in; once linked, the 6-digit
    // pairing code the phone asks for next.
    pairingSvg: (state.claim ?? state.pairing) ? qrSvg((state.claim ?? state.pairing).modules) : '',
    pairingCode: (state.claim ?? state.pairing) ? parsePairing((state.claim ?? state.pairing).link)?.code ?? '' : '',
    phoneAppUrl: PHONE_APP_URL,
    phoneAppSvg,
    openAtLogin: prefs.openAtLogin === true,
    logFile: join(userData, LOG_FILE),
  });

  const update = (patch) => {
    state = { ...state, ...patch };
    refreshTray();
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.send('host:changed', snapshot());
  };

  // ── the child ───────────────────────────────────────────────────────────
  const alreadyServing = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      return readHealth(await res.json()) !== null;
    } catch { return false; }
  };

  const spawn = async () => {
    if (quitting || child) return;
    if (await alreadyServing()) {
      // A second Belay.app is ruled out by the single-instance lock (main.js),
      // so this is the npx host: its LaunchAgent (com.belay.host) or a copy
      // in a Terminal. Two hosts on one port would fight over it at every
      // login, so wait, say so, and offer to take over from the agent.
      update({ phase: 'busy', launchAgent: launchAgentInstalled() });
      setTimeout(spawn, BUSY_RETRY_MS);
      return;
    }
    const dir = hostDir();
    const entry = join(dir, 'dist', 'index.js');
    if (!existsSync(entry)) {
      update({ phase: 'stopped', error: `host not built: ${entry} (run npm run stage in desktop/)` });
      return;
    }
    mkdirSync(userData, { recursive: true });
    const log = createWriteStream(join(userData, LOG_FILE), { flags: 'a' });
    child = utilityProcess.fork(entry, [], {
      cwd: userData,
      serviceName: 'Belay host',
      stdio: 'pipe',
      env: {
        ...process.env,
        BELAY_HOST_APP: '1',
        BELAY_STATE_FILE: join(userData, STATE_FILE),
        // The app's checklist owns the system prompts; the helper must not race it.
        BELAY_MAC_NO_PROMPT: '1',
      },
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.on('message', onChildMessage);
    child.on('exit', (code) => {
      child = null;
      log.end();
      update({ phase: 'stopped', error: code ? `host exited with code ${code}` : undefined });
      if (!quitting) setTimeout(spawn, RESTART_DELAY_MS);
    });
    update({ phase: 'starting', error: undefined });
  };

  // UtilityProcess emits the message itself (the child's parentPort wraps it in
  // a MessageEvent; this side does not).
  const onChildMessage = (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'pairing' && typeof data.link === 'string' && Array.isArray(data.modules)) {
      update({ pairing: { link: data.link, modules: data.modules } });
    } else if (data.type === 'claim') {
      // The account claim QR while unlinked; `link: null` once it is linked.
      update({ claim: typeof data.link === 'string' && Array.isArray(data.modules) ? { link: data.link, modules: data.modules } : null });
    } else if (data.type === 'listening') {
      update({ phase: 'running', paired: data.paired === true });
    } else if (data.type === 'autostart' && typeof data.id === 'number') {
      if (data.action === 'install') savePrefs({ ...prefs, openAtLogin: true });
      if (data.action === 'remove') savePrefs({ ...prefs, openAtLogin: false });
      child?.postMessage({ id: data.id, installed: prefs.openAtLogin === true });
    }
  };

  const poll = async () => {
    if (state.phase !== 'running') return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      const health = readHealth(await res.json());
      if (!health) return;
      savePrefs(loginItemAfterHealth(prefs, health.paired));
      const changed = health.devices !== state.devices || health.native !== state.native || health.paired !== state.paired;
      if (changed) update({ devices: health.devices, native: health.native, paired: health.paired, pairing: health.paired ? null : state.pairing });
    } catch { /* the next poll, or the exit handler, will say */ }
  };

  // ── the window ──────────────────────────────────────────────────────────
  const openHostWindow = () => {
    if (hostWindow && !hostWindow.isDestroyed()) { hostWindow.show(); hostWindow.focus(); return hostWindow; }
    hostWindow = new BrowserWindow({
      width: 480,
      height: 856,
      minWidth: 440,
      minHeight: 720,
      title: 'Belay',
      // Follows the OS, unlike the viewer: this window sits on the desktop
      // next to System Settings, so it should look like it belongs there.
      backgroundColor: nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light,
      webPreferences: {
        preload: join(__dirname, 'preload-host.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    hostWindow.loadFile(join(__dirname, 'renderer', 'host.html'));
    hostWindow.on('closed', () => { hostWindow = null; });
    return hostWindow;
  };

  ipcMain.handle('host:state', () => snapshot());
  ipcMain.handle('host:loginItem', (_event, on) => { savePrefs({ ...prefs, openAtLogin: on === true }); return prefs.openAtLogin; });
  ipcMain.handle('host:relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('host:openLogs', () => shell.openPath(join(userData, LOG_FILE)));
  ipcMain.handle('host:viewer', () => { openViewer(); return true; });
  // Only ever on the user's click: unload the developer LaunchAgent, park its
  // plist, and try the port again right away instead of waiting for the retry.
  ipcMain.handle('host:takeOver', async () => {
    try {
      await stopLaunchAgent({ run: (cmd, args) => promisify(execFile)(cmd, args) });
      update({ launchAgent: false, error: undefined });
      void spawn();
      return true;
    } catch (e) {
      update({ error: `Could not stop the old host: ${e?.message ?? e}` });
      return false;
    }
  });
  ipcMain.handle('host:permission', async (_event, { kind, action }) => {
    if (process.platform !== 'darwin' || !(kind in SETTINGS_PANE)) return permissions();
    if (action === 'open') {
      await shell.openExternal(SETTINGS_PANE[kind]);
    } else if (kind === 'accessibility') {
      systemPreferences.isTrustedAccessibilityClient(true);
    } else {
      // The one call that makes macOS show the Screen Recording consent sheet
      // for this bundle (CGRequestScreenCaptureAccess underneath).
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    }
    update({ perms: permissions() });
    return state.perms;
  });

  // ── the menu bar ────────────────────────────────────────────────────────
  const refreshTray = () => {
    if (!tray) return;
    tray.setToolTip(`Belay — ${statusLine(state)}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: statusLine(state), enabled: false },
      ...(state.error ? [{ label: state.error, enabled: false }] : []),
      { type: 'separator' },
      { label: state.paired ? 'Show status & QR…' : 'Link a phone (QR)…', click: openHostWindow },
      { label: 'Connect to a computer…', click: openViewer },
      { type: 'separator' },
      { label: 'Start at login', type: 'checkbox', checked: prefs.openAtLogin === true,
        click: (item) => savePrefs({ ...prefs, openAtLogin: item.checked }) },
      { label: 'Open host log', click: () => shell.openPath(join(userData, LOG_FILE)) },
      { type: 'separator' },
      { label: 'Quit Belay', click: () => app.quit() },
    ]));
  };

  // A template image (black + alpha, *Template.png with an @2x): macOS tints
  // it for light/dark menu bars and the highlighted state. On Windows and
  // Linux the tray wants colour, so the app icon stays there.
  const trayIcon = process.platform === 'darwin'
    ? nativeImage.createFromPath(join(__dirname, 'build', 'trayTemplate.png'))
    : nativeImage.createFromPath(join(__dirname, 'build', 'icon.png')).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.on('click', () => { if (process.platform !== 'darwin') openHostWindow(); });
  refreshTray();

  app.on('before-quit', () => { quitting = true; child?.kill(); });
  setInterval(poll, HEALTH_POLL_MS);
  void spawn();

  // Opened at login: stay in the menu bar; the user did not ask for a window.
  const atLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  if (!atLogin) openHostWindow();
  return openHostWindow;
}
