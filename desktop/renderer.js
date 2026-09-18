const $ = (id) => document.getElementById(id);
const SYNC_FILE = 'poupous-sync.json';

function b64utf8(s) { return btoa(unescape(encodeURIComponent(s))); }
function utf8b64(b) { try { return decodeURIComponent(escape(atob(b))); } catch (e) { return atob(b); } }

function loadConfig() {
  return {
    repo: localStorage.getItem('poupous_repo') || 'chibplanning-blip/poupous',
    token: localStorage.getItem('poupous_token') || ''
  };
}
function saveConfig(repo, token) {
  localStorage.setItem('poupous_repo', repo);
  localStorage.setItem('poupous_token', token);
}

let state = { memoire: [], conversation: [], sha: null };

function setStatus(msg) { $('status').textContent = msg; }

async function gh(method, path, body) {
  const cfg = loadConfig();
  const r = await fetch('https://api.github.com/repos/' + cfg.repo + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

async function pullSync() {
  const cfg = loadConfig();
  if (!cfg.repo || !cfg.token) { setStatus('Renseigne le dépôt et le token GitHub.'); return; }
  setStatus('Chargement...');
  const r = await gh('GET', '/contents/' + SYNC_FILE);
  if (r.status === 404) {
    state = { memoire: [], conversation: [], sha: null };
    setStatus("Aucune synchronisation trouvée pour l'instant (ouvre l'app sur le téléphone au moins une fois).");
    render();
    return;
  }
  if (r.status !== 200 || !r.data || !r.data.content) {
    setStatus('Erreur GitHub (' + r.status + ') : ' + (r.data && r.data.message ? r.data.message : 'vérifie ton token.'));
    return;
  }
  try {
    const remote = JSON.parse(utf8b64(r.data.content.replace(/\n/g, '')));
    state.memoire = Array.isArray(remote.memoire) ? remote.memoire : [];
    state.conversation = Array.isArray(remote.conversation) ? remote.conversation : [];
    state.sha = r.data.sha;
    setStatus('Synchronisé (' + new Date(remote.updatedAt || Date.now()).toLocaleString('fr-FR') + ')');
  } catch (e) {
    setStatus('Fichier de synchronisation illisible.');
    return;
  }
  render();
}

async function pushSync() {
  const payload = { memoire: state.memoire, conversation: state.conversation, updatedAt: new Date().toISOString() };
  const body = { message: 'Synchronisation Poupous (PC)', content: b64utf8(JSON.stringify(payload, null, 2)) };
  if (state.sha) body.sha = state.sha;
  const r = await gh('PUT', '/contents/' + SYNC_FILE, body);
  if (r.status !== 200 && r.status !== 201) {
    setStatus('Échec de l\'enregistrement (' + r.status + ').');
    return false;
  }
  state.sha = r.data && r.data.content ? r.data.content.sha : state.sha;
  setStatus('Enregistré.');
  return true;
}

function render() {
  const factsEl = $('facts');
  factsEl.innerHTML = '';
  if (!state.memoire.length) {
    factsEl.innerHTML = '<div class="empty">Aucun souvenir pour l\'instant.</div>';
  } else {
    state.memoire.forEach((fact, i) => {
      const div = document.createElement('div');
      div.className = 'fact';
      const span = document.createElement('span');
      span.textContent = fact;
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Suppr';
      del.onclick = async () => {
        state.memoire.splice(i, 1);
        render();
        await pushSync();
      };
      div.appendChild(span);
      div.appendChild(del);
      factsEl.appendChild(div);
    });
  }

  const histEl = $('history');
  histEl.innerHTML = '';
  if (!state.conversation.length) {
    histEl.innerHTML = '<div class="empty">Aucun historique pour l\'instant.</div>';
  } else {
    state.conversation.slice(-20).forEach((turn) => {
      const div = document.createElement('div');
      div.className = 'turn ' + (turn.role === 'user' ? 'user' : 'assistant');
      div.textContent = (turn.role === 'user' ? 'Toi : ' : 'Poupous : ') + turn.content;
      histEl.appendChild(div);
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const cfg = loadConfig();
  $('repo').value = cfg.repo;
  $('token').value = cfg.token;

  $('save-config').onclick = () => {
    saveConfig($('repo').value.trim(), $('token').value.trim());
    pullSync();
  };
  $('refresh').onclick = () => pullSync();
  $('add-fact').onclick = async () => {
    const val = $('new-fact').value.trim();
    if (!val) return;
    state.memoire.push(val);
    $('new-fact').value = '';
    render();
    await pushSync();
  };
  $('new-fact').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-fact').click(); });

  render();
  if (cfg.token) pullSync();
});
