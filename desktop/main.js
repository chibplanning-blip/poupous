const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    center: true,
    backgroundColor: '#05070d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function relay(url, options) {
  try {
    const r = await fetch(url, options);
    let data = null;
    try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: null, error: e.message || String(e) };
  }
}

ipcMain.handle('ai-claude', async (event, { apiKey, body }) => {
  return relay('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
});

ipcMain.handle('ai-gemini', async (event, { apiKey, model, body }) => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
  return relay(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
});
