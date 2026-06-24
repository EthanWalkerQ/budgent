const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("budgent", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (cfg) => ipcRenderer.invoke("config:set", cfg),
  loadVault: () => ipcRenderer.invoke("vault:load"),
  pay: (p) => ipcRenderer.invoke("pay", p),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
});
