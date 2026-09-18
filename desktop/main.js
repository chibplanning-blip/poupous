const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { exec } = require('child_process');
const os = require('os');
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

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err) => resolve({ ok: !err, error: err ? err.message : null }));
  });
}

function safeName(s) {
  return typeof s === 'string' && /^[\w .,()'-]{1,80}$/.test(s) ? s : null;
}

ipcMain.handle('pc-open-app', async (event, name) => {
  const n = safeName(name);
  if (!n) return { ok: false, error: 'nom invalide' };
  return run('start "" "' + n.replace(/"/g, '') + '"');
});

ipcMain.handle('pc-open-url', async (event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s"]+$/i.test(url)) return { ok: false, error: 'url invalide' };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('pc-lock', async () => run('rundll32.exe user32.dll,LockWorkStation'));
ipcMain.handle('pc-sleep', async () => run('rundll32.exe powrprof.dll,SetSuspendState 0,1,0'));

ipcMain.handle('pc-volume', async (event, dir) => {
  const key = dir === 'up' ? 175 : dir === 'down' ? 174 : 173;
  return run('powershell -WindowStyle Hidden -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]' + key + ')"');
});

ipcMain.handle('pc-shutdown', async () => run('shutdown /s /t 5'));
ipcMain.handle('pc-restart', async () => run('shutdown /r /t 5'));
ipcMain.handle('pc-cancel-shutdown', async () => run('shutdown /a'));

ipcMain.handle('sys-stats', async () => {
  const total = os.totalmem();
  const free = os.freemem();
  return { pct: Math.round((1 - free / total) * 100), usedGB: (total - free) / 1e9, totalGB: total / 1e9 };
});

ipcMain.handle('el-tts', async (event, { apiKey, voiceId, text }) => {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId), {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); msg = (j.detail && j.detail.message) || msg; } catch (e) {}
      return { ok: false, error: msg };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, base64: buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});
