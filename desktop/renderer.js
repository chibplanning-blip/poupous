const $ = (id) => document.getElementById(id);
const SYNC_FILE = 'poupous-sync.json';
const CLAUDE_MODEL = 'claude-sonnet-5';
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function b64utf8(s) { return btoa(unescape(encodeURIComponent(s))); }
function utf8b64(b) { try { return decodeURIComponent(escape(atob(b))); } catch (e) { return atob(b); } }

function loadConfig() {
  return {
    repo: localStorage.getItem('poupous_repo') || 'chibplanning-blip/poupous',
    token: localStorage.getItem('poupous_token') || '',
    provider: localStorage.getItem('poupous_ai_provider') || 'gemini',
    aiKey: localStorage.getItem('poupous_ai_key') || ''
  };
}
function saveGithubConfig(repo, token) {
  localStorage.setItem('poupous_repo', repo);
  localStorage.setItem('poupous_token', token);
}
function saveBrainConfig(provider, aiKey) {
  localStorage.setItem('poupous_ai_provider', provider);
  localStorage.setItem('poupous_ai_key', aiKey);
}

let state = { memoire: [], conversation: [], sha: null };
let sending = false;

function setStatus(msg, busy) {
  $('status-text').textContent = msg;
  $('sync-spin').classList.toggle('show', !!busy);
}
function setBrainStatus(msg, busy) {
  $('brain-status-text').textContent = msg;
  $('brain-spin').classList.toggle('show', !!busy);
}
function setRailDot(on) {
  $('rail-dot').classList.toggle('on', on);
  $('rail-dot').classList.toggle('off', !on);
}

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
  if (!cfg.repo || !cfg.token) { setStatus('Renseigne le dépôt et le jeton GitHub.'); setRailDot(false); return; }
  setStatus('Chargement...', true);
  const r = await gh('GET', '/contents/' + SYNC_FILE);
  if (r.status === 404) {
    state.sha = null;
    setStatus("Aucune synchronisation trouvée pour l'instant (ouvre l'app sur le téléphone au moins une fois).", false);
    setRailDot(true);
    render();
    return;
  }
  if (r.status !== 200 || !r.data || !r.data.content) {
    setStatus('Erreur GitHub (' + r.status + ') : ' + (r.data && r.data.message ? r.data.message : 'vérifie ton jeton.'), false);
    setRailDot(false);
    return;
  }
  try {
    const remote = JSON.parse(utf8b64(r.data.content.replace(/\n/g, '')));
    state.memoire = Array.isArray(remote.memoire) ? remote.memoire : [];
    state.conversation = Array.isArray(remote.conversation) ? remote.conversation : [];
    state.sha = r.data.sha;
    setStatus('Synchronisé (' + new Date(remote.updatedAt || Date.now()).toLocaleString('fr-FR') + ')', false);
    setRailDot(true);
  } catch (e) {
    setStatus('Fichier de synchronisation illisible.', false);
    setRailDot(false);
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
    setStatus('Échec de l\'enregistrement (' + r.status + ').', false);
    return false;
  }
  state.sha = r.data && r.data.content ? r.data.content.sha : state.sha;
  return true;
}

function render() { renderFacts(); renderChat(); }

function renderFacts() {
  const factsEl = $('facts');
  factsEl.innerHTML = '';
  if (!state.memoire.length) {
    factsEl.innerHTML = '<div class="empty">Aucun souvenir pour l\'instant.</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'fact-grid';
  state.memoire.forEach((fact, i) => {
    const div = document.createElement('div');
    div.className = 'fact';
    const span = document.createElement('span');
    span.textContent = fact;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Oublier';
    del.onclick = async () => {
      state.memoire.splice(i, 1);
      render();
      await pushSync();
    };
    div.appendChild(span);
    div.appendChild(del);
    grid.appendChild(div);
  });
  factsEl.appendChild(grid);
}

function renderChat() {
  const log = $('chatlog');
  log.innerHTML = '';
  if (!state.conversation.length) {
    log.innerHTML = '<div class="empty">Aucune conversation pour l\'instant. Écris ou parle ci-dessous.</div>';
    return;
  }
  state.conversation.slice(-40).forEach((turn) => {
    const div = document.createElement('div');
    div.className = 'bubble ' + (turn.role === 'user' ? 'user' : 'assistant');
    div.textContent = typeof turn.content === 'string' ? turn.content : '[pièce jointe]';
    log.appendChild(div);
  });
  log.scrollTop = log.scrollHeight;
}

function addThinkingBubble() {
  const log = $('chatlog');
  const div = document.createElement('div');
  div.className = 'bubble thinking';
  div.textContent = 'ANALYSE EN COURS...';
  div.id = 'thinking-bubble';
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function removeThinkingBubble() {
  const el = $('thinking-bubble');
  if (el) el.remove();
}

function askConfirm(message) {
  return new Promise((resolve) => {
    $('confirm-text').textContent = message;
    $('confirm-overlay').classList.add('show');
    const cleanup = (result) => {
      $('confirm-overlay').classList.remove('show');
      $('confirm-ok').onclick = null;
      $('confirm-cancel').onclick = null;
      resolve(result);
    };
    $('confirm-ok').onclick = () => cleanup(true);
    $('confirm-cancel').onclick = () => cleanup(false);
  });
}

const TOOLS = [
  { name: 'retenir', description: "Mémorise durablement une information sur l'utilisateur (prénom, goûts, proches, projets, habitudes) ou une consigne qu'il donne.",
    input_schema: { type: 'object', properties: { fait: { type: 'string' } }, required: ['fait'] } },
  { name: 'oublier', description: "Supprime les souvenirs qui contiennent ce texte ('*' pour tout effacer).",
    input_schema: { type: 'object', properties: { texte: { type: 'string' } }, required: ['texte'] } },
  { name: 'ouvrir_application', description: "Ouvre une application sur ce PC par son nom (ex: notepad, calc, chrome, explorer, mspaint).",
    input_schema: { type: 'object', properties: { nom: { type: 'string' } }, required: ['nom'] } },
  { name: 'ouvrir_site', description: "Ouvre une page web dans le navigateur par défaut du PC.",
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'verrouiller_pc', description: "Verrouille immédiatement la session Windows.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'mettre_en_veille', description: "Met le PC en veille.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'regler_volume', description: "Monte, baisse ou coupe le son du PC.",
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'mute'] } }, required: ['direction'] } },
  { name: 'redemarrer_pc', description: "Redémarre le PC. Une confirmation est toujours demandée à l'utilisateur avant l'exécution.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'eteindre_pc', description: "Éteint le PC. Une confirmation est toujours demandée à l'utilisateur avant l'exécution.",
    input_schema: { type: 'object', properties: {} } }
];

async function runTool(name, input) {
  if (name === 'retenir') {
    const f = String((input && input.fait) || '').trim();
    if (!f) return 'rien à retenir';
    if (!state.memoire.includes(f)) state.memoire.push(f);
    renderFacts();
    return 'noté';
  }
  if (name === 'oublier') {
    const t = String((input && input.texte) || '');
    const before = state.memoire.length;
    if (t === '*') state.memoire = [];
    else state.memoire = state.memoire.filter(f => !f.includes(t));
    renderFacts();
    return (before - state.memoire.length) + ' souvenir(s) supprimé(s)';
  }
  if (name === 'ouvrir_application') {
    const r = await window.pcBridge.openApp(String((input && input.nom) || ''));
    return r.ok ? 'application ouverte' : 'échec : ' + (r.error || 'inconnu');
  }
  if (name === 'ouvrir_site') {
    const r = await window.pcBridge.openUrl(String((input && input.url) || ''));
    return r.ok ? 'site ouvert' : 'échec : ' + (r.error || 'url invalide');
  }
  if (name === 'verrouiller_pc') {
    const r = await window.pcBridge.lock();
    return r.ok ? 'PC verrouillé' : 'échec : ' + (r.error || 'inconnu');
  }
  if (name === 'mettre_en_veille') {
    const r = await window.pcBridge.sleep();
    return r.ok ? 'mise en veille lancée' : 'échec : ' + (r.error || 'inconnu');
  }
  if (name === 'regler_volume') {
    const dir = String((input && input.direction) || '');
    const r = await window.pcBridge.volume(dir);
    return r.ok ? 'volume ajusté' : 'échec : ' + (r.error || 'inconnu');
  }
  if (name === 'redemarrer_pc') {
    const ok = await askConfirm('Poupous veut redémarrer le PC. Confirmer ?');
    if (!ok) return "annulé par l'utilisateur";
    const r = await window.pcBridge.restart();
    return r.ok ? 'redémarrage lancé (annulable dans les 5 secondes)' : 'échec : ' + (r.error || 'inconnu');
  }
  if (name === 'eteindre_pc') {
    const ok = await askConfirm('Poupous veut éteindre le PC. Confirmer ?');
    if (!ok) return "annulé par l'utilisateur";
    const r = await window.pcBridge.shutdown();
    return r.ok ? 'extinction lancée (annulable dans les 5 secondes)' : 'échec : ' + (r.error || 'inconnu');
  }
  return 'outil inconnu';
}

function systemPromptPC() {
  const d = new Date();
  const date = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return "Tu es Poupous, l'assistant personnel de l'utilisateur, ici dans son application de bureau sur PC (Windows). Tu n'as pas accès aux fonctions du téléphone (appeler, SMS, alarme, GPS).\n" +
    "Nous sommes le " + date + ", il est " + heure + ".\n" +
    "Réponds en français, de façon naturelle et concise (une à trois phrases, sauf si on te demande des détails) : tes réponses peuvent être lues à voix haute. Pas de markdown, pas de listes à puces, pas d'emojis.\n" +
    "RÈGLE ABSOLUE : n'annonce jamais une action que tu n'exécutes pas. Si tu dis que tu retiens, ouvres, verrouilles, règles le volume ou éteins/redémarres, tu DOIS appeler l'outil correspondant dans la même réponse.\n" +
    "Outils PC disponibles : ouvrir_application, ouvrir_site, verrouiller_pc, mettre_en_veille, regler_volume, redemarrer_pc, eteindre_pc (les deux derniers demandent toujours une confirmation à l'utilisateur, qui peut refuser).\n" +
    "Tu peux retenir ou oublier durablement des informations sur l'utilisateur avec retenir/oublier ; elles sont partagées avec son téléphone.\n" +
    "Souvenirs sur l'utilisateur :\n" + (state.memoire.length ? state.memoire.map(f => '- ' + f).join('\n') : "(aucun pour l'instant)");
}

async function callClaudeBrain(messages, apiKey) {
  let msgs = messages.slice();
  let finalText = '';
  for (let round = 0; round < 4; round++) {
    const r = await window.aiBridge.claude(apiKey, {
      model: CLAUDE_MODEL, max_tokens: 1024, system: systemPromptPC(), tools: TOOLS, messages: msgs
    });
    if (r.status !== 200 || !r.data) {
      const why = r.status === 401 ? 'clé API refusée' : (r.data && r.data.error && r.data.error.message) || ('HTTP ' + r.status);
      throw new Error(why);
    }
    const blocks = r.data.content || [];
    const texts = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    if (texts) finalText = texts;
    const calls = blocks.filter(b => b.type === 'tool_use');
    if (!calls.length) break;
    msgs.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const c of calls) results.push({ type: 'tool_result', tool_use_id: c.id, content: String(await runTool(c.name, c.input || {})) });
    msgs.push({ role: 'user', content: results });
  }
  return finalText;
}

function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const k in s) {
    if (k === 'type') o.type = String(s.type).toUpperCase();
    else if (k === 'properties') { o.properties = {}; for (const q in s.properties) o.properties[q] = toGeminiSchema(s.properties[q]); }
    else o[k] = s[k];
  }
  return o;
}

async function callGeminiBrain(messages, apiKey) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = typeof m.content === 'string' ? [{ text: m.content }] : m.content;
    if (contents.length && contents[contents.length - 1].role === role) contents[contents.length - 1].parts.push(...parts);
    else contents.push({ role, parts });
  }
  const tools = [{ functionDeclarations: TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema.properties && Object.keys(t.input_schema.properties).length ? toGeminiSchema(t.input_schema) : undefined })) }];
  let finalText = '';
  for (let round = 0; round < 4; round++) {
    let data = null, lastErr = null;
    for (const model of GEMINI_MODELS) {
      const r = await window.aiBridge.gemini(apiKey, model, {
        systemInstruction: { parts: [{ text: systemPromptPC() }] }, contents, tools, generationConfig: { maxOutputTokens: 2048 }
      });
      if (r.status === 200 && r.data) { data = r.data; break; }
      lastErr = (r.data && r.data.error && r.data.error.message) || ('HTTP ' + r.status);
    }
    if (!data) throw new Error(lastErr || 'Gemini indisponible');
    const cand = (data.candidates || [])[0];
    if (!cand || !cand.content) break;
    const parts = cand.content.parts || [];
    const texts = parts.filter(x => x.text).map(x => x.text).join(' ').trim();
    if (texts) finalText = texts;
    const calls = parts.filter(x => x.functionCall);
    if (!calls.length) break;
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const c of calls) responses.push({ functionResponse: { name: c.functionCall.name, response: { resultat: String(await runTool(c.functionCall.name, c.functionCall.args || {})) } } });
    contents.push({ role: 'user', parts: responses });
  }
  return finalText;
}

async function sendChat() {
  if (sending) return;
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const cfg = loadConfig();
  if (!cfg.aiKey) {
    state.conversation.push({ role: 'assistant', content: "Il me faut ta clé API pour réfléchir — va dans l'onglet Cerveau." });
    renderChat();
    return;
  }
  sending = true;
  $('chat-send').disabled = true;
  input.value = '';
  state.conversation.push({ role: 'user', content: text });
  renderChat();
  addThinkingBubble();
  const messages = state.conversation.slice(-20).map(t => ({ role: t.role, content: t.content }));
  let answer = '';
  try {
    answer = cfg.provider === 'claude'
      ? await callClaudeBrain(messages, cfg.aiKey)
      : await callGeminiBrain(messages, cfg.aiKey);
    removeThinkingBubble();
    state.conversation.push({ role: 'assistant', content: answer || "Je n'ai rien à répondre." });
    state.conversation = state.conversation.slice(-40);
    renderChat();
    await pushSync();
  } catch (e) {
    removeThinkingBubble();
    answer = 'Erreur : ' + (e.message || e);
    state.conversation.push({ role: 'assistant', content: answer });
    renderChat();
  } finally {
    sending = false;
    $('chat-send').disabled = false;
    input.focus();
  }
  if (handsFree) speak(answer, () => { if (handsFree) startListening(); });
}

function switchPanel(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
}

// --- Voice ---
let handsFree = false;
let recognizing = false;
let recognition = null;

function getRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  if (!recognition) {
    recognition = new SR();
    recognition.lang = 'fr-FR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
  }
  return recognition;
}

function isStopWord(t) { return /^(stop|arrête|arrete|arrête[- ]toi|arrete[- ]toi)\s*\.?$/i.test(t.trim()); }

function startListening() {
  const rec = getRecognition();
  if (!rec || recognizing || sending) return;
  recognizing = true;
  $('mic-btn').classList.add('listening');
  rec.onresult = (e) => {
    const text = (e.results[0] && e.results[0][0] && e.results[0][0].transcript) || '';
    recognizing = false;
    $('mic-btn').classList.remove('listening');
    if (!text.trim()) { if (handsFree) startListening(); return; }
    if (handsFree && isStopWord(text)) { setHandsFree(false); return; }
    $('chat-input').value = text;
    sendChat();
  };
  rec.onerror = () => { recognizing = false; $('mic-btn').classList.remove('listening'); if (handsFree) setTimeout(() => { if (handsFree) startListening(); }, 800); };
  rec.onend = () => { recognizing = false; $('mic-btn').classList.remove('listening'); };
  try { rec.start(); } catch (e) { recognizing = false; }
}

function speak(text, onDone) {
  try {
    if (!window.speechSynthesis || !text) { if (onDone) onDone(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.onend = () => { if (onDone) onDone(); };
    u.onerror = () => { if (onDone) onDone(); };
    speechSynthesis.speak(u);
  } catch (e) { if (onDone) onDone(); }
}

function setHandsFree(on) {
  handsFree = on;
  $('hf-switch').classList.toggle('on', on);
  if (on) startListening();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.hud-frame').forEach(el => {
    ['tl', 'tr', 'bl', 'br'].forEach(pos => {
      const s = document.createElement('span');
      s.className = 'corner ' + pos;
      el.appendChild(s);
    });
  });

  const cfg = loadConfig();
  $('repo').value = cfg.repo;
  $('token').value = cfg.token;
  $('ai-key').value = cfg.aiKey;
  $('pill-gemini').classList.toggle('selected', cfg.provider === 'gemini');
  $('pill-claude').classList.toggle('selected', cfg.provider === 'claude');
  $('key-label').textContent = cfg.provider === 'claude' ? 'Clé API Claude' : 'Clé API Gemini (gratuite)';

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => switchPanel(btn.dataset.panel);
  });

  $('pill-gemini').onclick = () => { $('pill-gemini').classList.add('selected'); $('pill-claude').classList.remove('selected'); $('key-label').textContent = 'Clé API Gemini (gratuite)'; };
  $('pill-claude').onclick = () => { $('pill-claude').classList.add('selected'); $('pill-gemini').classList.remove('selected'); $('key-label').textContent = 'Clé API Claude'; };

  $('save-brain').onclick = () => {
    const provider = $('pill-claude').classList.contains('selected') ? 'claude' : 'gemini';
    const key = $('ai-key').value.trim();
    saveBrainConfig(provider, key);
    setBrainStatus(key ? 'Clé enregistrée.' : 'Aucune clé enregistrée.', false);
  };

  $('save-config').onclick = () => {
    saveGithubConfig($('repo').value.trim(), $('token').value.trim());
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

  $('chat-send').onclick = sendChat;
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    $('mic-btn').disabled = true;
    $('mic-btn').title = 'Reconnaissance vocale indisponible';
    $('hf-switch').style.opacity = '.4';
    $('hf-switch').style.pointerEvents = 'none';
  } else {
    $('mic-btn').onclick = () => startListening();
    $('hf-switch').onclick = () => setHandsFree(!handsFree);
  }

  render();
  if (cfg.token) pullSync();
});
