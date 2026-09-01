// The renderer's only route to anything privileged.
//
// Deliberately four narrow calls rather than a general "invoke any channel"
// bridge: the renderer handles frames and HTML from a host on the network, and
// the smaller this surface is, the less a compromised page can reach.
//
// CommonJS on purpose — Electron loads sandboxed preload scripts as CJS.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskhandler', {
  /** The saved host and token, or empty strings when not paired yet. */
  readSession: () => ipcRenderer.invoke('session:read'),
  saveSession: (session) => ipcRenderer.invoke('session:write', session),
  /** Forget the host and close every open display window. */
  clearSession: () => ipcRenderer.invoke('session:clear'),
  /** Open one remote display in its own desktop window. */
  openDisplay: (session, display) => ipcRenderer.invoke('display:open', { session, display }),
  /** Open one or more of the host's windows, each as a local window. */
  openWindows: (session, windows) => ipcRenderer.invoke('window:open', { session, windows }),
  /** Match this window's size to the remote window's (seamless mode only). */
  resizeSelf: (width, height) => ipcRenderer.invoke('window:resize', { width, height }),
  /** Follow the remote window's title, which changes as the user works. */
  setTitle: (title) => ipcRenderer.invoke('window:title', title),
  /** The remote window is gone; close this one. */
  closeSelf: () => ipcRenderer.invoke('window:close'),
});
