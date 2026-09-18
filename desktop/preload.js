const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiBridge', {
  claude: (apiKey, body) => ipcRenderer.invoke('ai-claude', { apiKey, body }),
  gemini: (apiKey, model, body) => ipcRenderer.invoke('ai-gemini', { apiKey, model, body })
});

contextBridge.exposeInMainWorld('pcBridge', {
  openApp: (name) => ipcRenderer.invoke('pc-open-app', name),
  openUrl: (url) => ipcRenderer.invoke('pc-open-url', url),
  lock: () => ipcRenderer.invoke('pc-lock'),
  sleep: () => ipcRenderer.invoke('pc-sleep'),
  volume: (dir) => ipcRenderer.invoke('pc-volume', dir),
  shutdown: () => ipcRenderer.invoke('pc-shutdown'),
  restart: () => ipcRenderer.invoke('pc-restart'),
  cancelShutdown: () => ipcRenderer.invoke('pc-cancel-shutdown')
});

contextBridge.exposeInMainWorld('sysBridge', {
  stats: () => ipcRenderer.invoke('sys-stats')
});
