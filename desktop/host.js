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

import {
  accountsBase, appleSignIn, emailStart, emailVerify, googleSignIn, providers, signInConfig,
} from './src/account-signin.js';
import { GROUND } from './src/ground.js';
import {
  PHONE_APP_URL, livePairing, loginItemAfterHealth, pairingFromMessage, parsePairing, pendingFromMessage, phonesFromMessage,
  qrSvg, readHealth, statusLine, firstPhoneState, ownerAuthNotice,
} from './src/host-status.js';
import { launchAgentInstalled, stopLaunchAgent } from './src/launch-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8787;
const HEALTH_POLL_MS = 4_000;
const BUSY_RETRY_MS = 10_000;
const RESTART_DELAY_MS = 3_000;
const PREFS_FILE = 'host-prefs.json';
const STATE_FILE = 'belay-state.json';
const LOG_FILE = 'host.log';
const LINK_TIMEOUT_MS = 30_000;
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
  let state = { phase: 'starting', port, devices: 0, native: false, paired: false, pairing: null, claim: null, linkedTo: null, accountLinked: false, firstPhoneUntil: 0, phones: [], pendingPhones: [], ownerAuth: null, perms: permissions() };
  const signIn = signInConfig();
  const signInProviders = providers(signIn);
  const phoneAppSvg = qrSvg(qrModules(PHONE_APP_URL));

  const savePrefs = (next) => {
    if (next === prefs) return;
    prefs = next;
    writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
    app.setLoginItemSettings({ openAtLogin: prefs.openAtLogin === true, openAsHidden: true });
  };

  const snapshot = () => {
    // Unlinked, the account claim QR is the way in; once linked, the 6-digit
    // pairing code the phone asks for next — also while phones are already
    // paired, when a new one asked or "Pair another phone" was chosen (#150),
    // until the code expires.
    // Account-linked with no phone yet: the first phone connects by itself
    // (account trust) or with a tap here, so the 6-digit code is not shown.
    const firstPhone = firstPhoneState(state, Date.now());
    const shown = state.claim ?? (firstPhone !== 'none' ? null : livePairing(state.pairing, Date.now()));
    return {
    ...state,
    // Live, not cached: the user flips these in System Settings while we watch.
    perms: permissions(),
    pairingSvg: shown ? qrSvg(shown.modules) : '',
    pairingCode: shown ? parsePairing(shown.link)?.code ?? '' : '',
    firstPhone,
    pendingPhones: pendingFromMessage({ requests: state.pendingPhones }, Date.now()),
    phoneAppUrl: PHONE_APP_URL,
    phoneAppSvg,
    signInProviders,
    openAtLogin: prefs.openAtLogin === true,
    logFile: join(userData, LOG_FILE),
    };
  };

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
    if (data.type === 'pairing') {
      const pairing = pairingFromMessage(data, Date.now());
      if (pairing) {
        update({ pairing });
        // A phone asked while this Mac is already paired: put the code in front
        // of the person, not only in a popup that times out.
        if (state.paired) openHostWindow();
      }
    } else if (data.type === 'claim') {
      // The account claim QR while unlinked; `link: null` once it is linked.
      update({ claim: typeof data.link === 'string' && Array.isArray(data.modules) ? { link: data.link, modules: data.modules } : null });
    } else if (data.type === 'pair-pending') {
      const pendingPhones = pendingFromMessage(data, Date.now());
      const fresh = pendingPhones.some((p) => !state.pendingPhones.some((q) => q.id === p.id));
      update({ pendingPhones });
      // A phone is asking to be let in: put Allow/Deny in front of the person.
      if (fresh) openHostWindow();
    } else if (data.type === 'devices') {
      const { linked, phones, firstPhoneUntil } = phonesFromMessage(data);
      update({ accountLinked: linked, firstPhoneUntil, phones, devices: phones.length, paired: phones.length > 0, pairing: phones.length > state.devices ? null : state.pairing });
    } else if (data.type === 'owner-auth') {
      // The host asked for Touch ID or the password before a gated command;
      // a refusal leaves everything as it was and says "Not approved".
      update({ ownerAuth: ownerAuthNotice(data) });
    } else if (data.type === 'link-result') {
      linkWaiter?.(data);
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
      // One more phone than before means the code on screen was just used.
      if (changed) update({ devices: health.devices, native: health.native, paired: health.paired, pairing: health.devices > state.devices ? null : state.pairing });
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

  // ── sign in on this computer → linked, no QR ────────────────────────────
  // The session lives only in these calls: straight to the host child for one
  // POST /hosts/link (it signs the node proof and stores the host credential
  // at 0600), then dropped. Never on disk, never sent to the renderer.
  let linkWaiter = null;
  const linkWithSession = (session) => new Promise((resolve) => {
    if (!child) { resolve({ ok: false, error: 'Belay is not running yet. Try again in a moment.' }); return; }
    const timer = setTimeout(() => { linkWaiter = null; resolve({ ok: false, error: 'This computer did not answer. Try again.' }); }, LINK_TIMEOUT_MS);
    linkWaiter = (result) => {
      clearTimeout(timer);
      linkWaiter = null;
      resolve(result.ok === true
        ? { ok: true, maskedEmail: typeof result.maskedEmail === 'string' ? result.maskedEmail : null }
        : { ok: false, error: typeof result.error === 'string' ? result.error : 'Could not link this computer.' });
    };
    child.postMessage({ type: 'link-session', session });
  });
  const signInThen = async (getSession) => {
    try {
      const result = await linkWithSession(await getSession());
      if (result.ok) update({ linkedTo: result.maskedEmail ?? 'your Belay account', claim: null });
      return result;
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  };
  const openUrl = (url) => shell.openExternal(url);
  ipcMain.handle('host:signin:emailStart', async (_event, email) => {
    try { await emailStart(accountsBase(), email); return { ok: true }; } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
  });
  ipcMain.handle('host:signin:emailVerify', (_event, { email, code } = {}) => signInThen(() => emailVerify(accountsBase(), email, code)));
  ipcMain.handle('host:signin:provider', (_event, name) => {
    if (name === 'google' && signInProviders.google) return signInThen(() => googleSignIn({ config: signIn, base: accountsBase(), openUrl }));
    if (name === 'apple' && signInProviders.apple) return signInThen(() => appleSignIn({ config: signIn, base: accountsBase(), openUrl }));
    return { ok: false, error: 'That sign-in is not set up in this build.' };
  });

  ipcMain.handle('host:state', () => snapshot());
  // Account trust: Deny and Remove go straight to the host. Allow, "Let a
  // phone connect" and "Pair another phone" are relayed as-is: the host itself
  // asks for Touch ID or the Mac password (server/src/app-commands.ts) and only
  // then acts, so nothing here or in the page can skip it. The ids are checked
  // here and again in the host.
  ipcMain.handle('host:decidePhone', (_event, { pendingId, allow } = {}) => {
    if (typeof pendingId !== 'string' || !/^[0-9a-f]{32}$/.test(pendingId) || typeof allow !== 'boolean') return false;
    child?.postMessage({ type: 'pair-decide', pendingId, allow });
    // An Allow stays listed until the host's pair-pending says it is settled.
    if (!allow) update({ pendingPhones: state.pendingPhones.filter((p) => p.id !== pendingId) });
    return Boolean(child);
  });
  // "Let a phone connect": reopen the first-phone window for 15 minutes (owner check in the host).
  ipcMain.handle('host:openFirstPhone', () => {
    child?.postMessage({ type: 'open-first-phone' });
    return Boolean(child);
  });
  ipcMain.handle('host:removePhone', (_event, tokenPrefix) => {
    if (typeof tokenPrefix !== 'string' || !/^[0-9a-f]{4,64}$/.test(tokenPrefix)) return false;
    child?.postMessage({ type: 'device-remove', tokenPrefix });
    return Boolean(child);
  });
  ipcMain.handle('host:loginItem', (_event, on) => { savePrefs({ ...prefs, openAtLogin: on === true }); return prefs.openAtLogin; });
  ipcMain.handle('host:relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('host:openLogs', () => shell.openPath(join(userData, LOG_FILE)));
  ipcMain.handle('host:viewer', () => { openViewer(); return true; });
  // The host mints (or re-shows) a code and posts it back as a `pairing` message.
  const pairAnother = () => { child?.postMessage({ type: 'pair-code' }); openHostWindow(); return Boolean(child); };
  ipcMain.handle('host:pairAnother', pairAnother);
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
      ...(state.paired ? [{ label: 'Pair another phone…', click: pairAnother }] : []),
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
