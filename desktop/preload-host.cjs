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
  /** Stop the developer LaunchAgent so this app can have the port. */
  takeOver: () => ipcRenderer.invoke('host:takeOver'),
  /** Sign in on this computer to link it. Each answers {ok, error?, maskedEmail?}; no session ever comes back. */
  emailStart: (email) => ipcRenderer.invoke('host:signin:emailStart', String(email)),
  emailVerify: (email, code) => ipcRenderer.invoke('host:signin:emailVerify', { email: String(email), code: String(code) }),
  /** name: 'apple' | 'google' — opens the system browser. */
  signInWith: (name) => ipcRenderer.invoke('host:signin:provider', String(name)),
});
