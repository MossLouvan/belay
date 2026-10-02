// The host window's bridge. As narrow as preload.cjs: this page shows a QR
// and a checklist, so it can read the host's state, poke a permission, flip
// the login item, relaunch, and nothing else.

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
});
