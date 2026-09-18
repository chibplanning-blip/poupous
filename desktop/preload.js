const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiBridge', {
  claude: (apiKey, body) => ipcRenderer.invoke('ai-claude', { apiKey, body }),
  gemini: (apiKey, model, body) => ipcRenderer.invoke('ai-gemini', { apiKey, model, body })
});
