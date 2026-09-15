// =============================================================================
// Local Mind Browser — Onion shell bridge
// =============================================================================
// The Onion window is its own small browser: an address bar, a webview, and a
// start page. It shares nothing with the main window's preload, deliberately —
// the AI assistant, memory, notes and history have no business in a session
// whose whole purpose is leaving no trace.

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('onion', {
  /** Live Tor status: { state, progress, error, socksPort } */
  status: () => ipcRenderer.invoke('onion:status'),
  onStatus: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('onion:status', fn);
    return () => ipcRenderer.removeListener('onion:status', fn);
  },

  /** Security level: { level, levels }. */
  level: () => ipcRenderer.invoke('onion:level'),
  setLevel: (l) => ipcRenderer.invoke('onion:set-level', l),
  onLevel: (cb) => {
    const fn = (_e, info) => cb(info);
    ipcRenderer.on('onion:level', fn);
    return () => ipcRenderer.removeListener('onion:level', fn);
  },

  /** A fresh circuit only: same session, different path. */
  newCircuit: () => ipcRenderer.invoke('onion:new-circuit'),

  /** New Identity: clears all state AND rebuilds circuits. */
  newIdentity: () => ipcRenderer.invoke('onion:new-identity'),
  onNewIdentity: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('onion:new-identity', fn);
    return () => ipcRenderer.removeListener('onion:new-identity', fn);
  },

  /** A site advertised its own onion service. */
  onOnionLocation: (cb) => {
    const fn = (_e, info) => cb(info);
    ipcRenderer.on('onion:location', fn);
    return () => ipcRenderer.removeListener('onion:location', fn);
  },

  /** Where the page preload lives, for the <webview> tag. */
  pagePreload: () => ipcRenderer.invoke('onion:page-preload'),

  /** Open a clearnet link in the user's normal browser, never in this window. */
  openExternal: (url) => shell.openExternal(url)
});
