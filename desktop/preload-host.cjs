// The host window's bridge. As narrow as preload.cjs: this page shows a QR
// and a checklist, so it can read the host's state, poke a permission, flip
// the login item, relaunch, sign in to link this computer, and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('belayHost', {
  state: () => ipcRenderer.invoke('host:state'),
  onChange: (fn) => { ipcRenderer.on('host:changed', (_event, state) => fn(state)); },
  /** kind: 'screen' | 'accessibility'; action: 'request' | 'open' */
  permission: (kind, action) => ipcRenderer.invoke('host:permission', { kind, action }),
  setLoginItem: (on) => ipcRenderer.invoke('host:loginItem', on),
  relaunch: () => ipcRenderer.invoke('host:relaunch'),
  openLogs: () => ipcRenderer.invoke('host:openLogs'),
  openViewer: () => ipcRenderer.invoke('host:viewer'),
  /** Ask the host for a fresh pairing code for one more phone. */
  pairAnother: () => ipcRenderer.invoke('host:pairAnother'),
  /** Allow or deny a phone on this account that asked to connect. */
  decidePhone: (pendingId, allow) => ipcRenderer.invoke('host:decidePhone', { pendingId: String(pendingId), allow: allow === true }),
  /** Let the first phone on the account connect without a tap for 15 minutes. */
  openFirstPhone: () => ipcRenderer.invoke('host:openFirstPhone'),
  /** Unpair a phone by its token-hash prefix. */
  removePhone: (tokenPrefix) => ipcRenderer.invoke('host:removePhone', String(tokenPrefix)),
  /** Stop the developer LaunchAgent so this app can have the port. */
  takeOver: () => ipcRenderer.invoke('host:takeOver'),
  /** Sign in on this computer to link it. Each answers {ok, error?, maskedEmail?}; no session ever comes back. */
  emailStart: (email) => ipcRenderer.invoke('host:signin:emailStart', String(email)),
  emailVerify: (email, code) => ipcRenderer.invoke('host:signin:emailVerify', { email: String(email), code: String(code) }),
  /** name: 'apple' | 'google' — opens the system browser. */
  signInWith: (name) => ipcRenderer.invoke('host:signin:provider', String(name)),
});

// The appearance (Harbour, Night, Current, Fieldwork), read by renderer/look.js.
// Duplicated in both preloads: a sandboxed preload cannot require a sibling.
contextBridge.exposeInMainWorld('belayLook', {
  /** `{ mode, name, look, scheme }` — sync, so the page paints in it first time. */
  current: () => ipcRenderer.sendSync('look:get'),
  /** mode: 'harbour' | 'night' | 'current' | 'fieldwork' */
  set: (mode) => ipcRenderer.invoke('look:set', String(mode)),
  onChange: (fn) => { ipcRenderer.on('look:changed', (_event, look) => fn(look)); },
});
