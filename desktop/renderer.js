const $ = (id) => document.getElementById(id);
const SYNC_FILE = 'poupous-sync.json';
const CLAUDE_MODEL = 'claude-sonnet-5';
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function b64utf8(s) { return btoa(unescape(encodeURIComponent(s))); }
function utf8b64(b) { try { return decodeURIComponent(escape(atob(b))); } catch (e) { return atob(b); } }

function loadConfig() {
  return {
    repo: localStorage.getItem('poupous_repo') || 'chibplanning-blip/poupous',
    token: localStorage.getItem('poupous_token') || '',
    provider: localStorage.getItem('poupous_ai_provider') || 'gemini',
    aiKey: localStorage.getItem('poupous_ai_key') || '',
    elevenKey: localStorage.getItem('poupous_eleven_key') || '',
    elevenVoice: localStorage.getItem('poupous_eleven_voice') || '',
    wakeWord: localStorage.getItem('poupous_wake_word') || 'poupous',
    sttKeyRaw: localStorage.getItem('poupous_stt_key') || ''
  };
}
function effectiveSttKey(cfg) { return cfg.provider === 'gemini' ? cfg.aiKey : cfg.sttKeyRaw; }
function saveSttKey(key) { localStorage.setItem('poupous_stt_key', key); }
function saveGithubConfig(repo, token) {
  localStorage.setItem('poupous_repo', repo);
  localStorage.setItem('poupous_token', token);
}
function saveBrainConfig(provider, aiKey) {
  localStorage.setItem('poupous_ai_provider', provider);
  localStorage.setItem('poupous_ai_key', aiKey);
}
function saveElevenConfig(key, voiceId) {
  localStorage.setItem('poupous_eleven_key', key);
  localStorage.setItem('poupous_eleven_voice', voiceId);
}
function saveWakeWord(word) {
  localStorage.setItem('poupous_wake_word', word);
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
  const circ = 100.5;
  $('sync-fg').style.stroke = on ? '#4ade80' : 'var(--danger)';
  $('sync-fg').style.strokeDashoffset = on ? 0 : circ;
  $('sync-pct').textContent = on ? 'OK' : '--';
}

const RADAR_LABELS = { idle: 'VEILLE', listening: 'ÉCOUTE', thinking: 'ANALYSE', speaking: 'RÉPONSE' };
function setRadarState(name) {
  const el = $('status-radar');
  el.classList.remove('listening', 'thinking', 'speaking');
  if (name !== 'idle') el.classList.add(name);
  $('radar-label').textContent = RADAR_LABELS[name] || 'VEILLE';
}

function updateClock() {
  const d = new Date();
  $('clock-time').textContent = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('clock-date').textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

async function updateRamGauge() {
  try {
    if (!window.sysBridge) return;
    const s = await window.sysBridge.stats();
    const circ = 100.5;
    $('ram-fg').style.strokeDashoffset = String(circ * (1 - s.pct / 100));
    $('ram-pct').textContent = s.pct + '%';
  } catch (e) {}
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

async function pushFile(path, contentText, message) {
  const cur = await gh('GET', '/contents/' + encodeURI(path));
  const body = { message, content: b64utf8(contentText) };
  if (cur.status === 200 && cur.data && cur.data.sha) body.sha = cur.data.sha;
  const r = await gh('PUT', '/contents/' + encodeURI(path), body);
  if (r.status !== 200 && r.status !== 201) {
    const why = r.status === 401 ? 'jeton GitHub refusé' : (r.status === 403 || r.status === 404) ? 'jeton sans accès en écriture' : ((r.data && r.data.message) || ('HTTP ' + r.status));
    throw new Error(why);
  }
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
    input_schema: { type: 'object', properties: {} } },
  { name: 'ameliorer_pc', description: "Modifie le code de cette application PC elle-même (interface, fonctionnalités) et publie une nouvelle version sur GitHub. La construction prend 5 à 15 minutes ; il faudra retélécharger et réinstaller l'application une fois prête.",
    input_schema: { type: 'object', properties: { demande: { type: 'string' } }, required: ['demande'] } }
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
  if (name === 'ameliorer_pc') {
    return await runPcUpgrade(String((input && input.demande) || ''));
  }
  return 'outil inconnu';
}

const UPGRADE_FILES = ['desktop/index.html', 'desktop/renderer.js', 'desktop/main.js', 'desktop/preload.js'];
const FSTART = '===FICHIER ', FEND = '===', FDONE = '===FIN_FICHIER===';

async function fetchRepoFile(path) {
  const r = await gh('GET', '/contents/' + path);
  if (r.status !== 200 || !r.data || !r.data.content) throw new Error('impossible de lire ' + path + ' (HTTP ' + r.status + ')');
  return utf8b64(r.data.content.replace(/\n/g, ''));
}

async function completeForUpgrade(rules, userMsg) {
  const cfg = loadConfig();
  if (!cfg.aiKey) throw new Error("il faut une clé API dans l'onglet Cerveau");
  if (cfg.provider === 'claude') {
    const r = await window.aiBridge.claude(cfg.aiKey, { model: 'claude-opus-5', max_tokens: 16000, system: rules, messages: [{ role: 'user', content: userMsg }] });
    if (r.status !== 200 || !r.data) throw new Error((r.data && r.data.error && r.data.error.message) || ('HTTP ' + r.status));
    return (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    const r = await window.aiBridge.gemini(cfg.aiKey, model, { systemInstruction: { parts: [{ text: rules }] }, contents: [{ role: 'user', parts: [{ text: userMsg }] }], generationConfig: { maxOutputTokens: 16000 } });
    if (r.status === 200 && r.data) {
      const cand = (r.data.candidates || [])[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      return parts.filter(x => x.text).map(x => x.text).join('');
    }
    lastErr = (r.data && r.data.error && r.data.error.message) || ('HTTP ' + r.status);
  }
  throw new Error(lastErr || 'Gemini indisponible');
}

async function runPcUpgrade(demande) {
  const cfg = loadConfig();
  if (!cfg.token || !cfg.repo) return "Il me faut une connexion GitHub configurée dans l'onglet Connexion pour pouvoir me modifier.";
  if (!demande.trim()) return 'rien à modifier';
  const current = {};
  try {
    for (const path of UPGRADE_FILES) current[path] = await fetchRepoFile(path);
  } catch (e) { return "Je n'arrive pas à lire mon propre code sur GitHub (" + (e.message || e) + ")."; }

  const rules = "Tu es un développeur expert en Electron (JavaScript + HTML). Tu modifies l'application de bureau Windows de Poupous : main.js (processus principal Electron), preload.js (pont contextBridge), renderer.js et index.html (interface).\n" +
    "Contraintes impératives :\n" +
    "- Renvoie uniquement les fichiers modifiés, chacun COMPLET (jamais un extrait ni un diff).\n" +
    "- Ne supprime aucune fonctionnalité existante : discussion avec Gemini/Claude, outils retenir/oublier, outils PC (ouvrir_application, ouvrir_site, verrouiller_pc, mettre_en_veille, regler_volume, redemarrer_pc, eteindre_pc avec confirmation), synchronisation GitHub (poupous-sync.json), voix ElevenLabs, mode mains libres avec mot-clé, tableau de bord (horloge, radar, jauges), et l'outil ameliorer_pc lui-même.\n" +
    "- N'ajoute aucune dépendance npm : package.json ne peut pas changer.\n" +
    "- Aucune ressource externe (CDN, police en ligne) dans index.html.\n" +
    "- Le code JavaScript doit être syntaxiquement valide.\n" +
    "- Change seulement ce qui est demandé ; garde tout le reste fonctionnel et en français.\n" +
    "Format de réponse exact, sans markdown : pour chaque fichier modifié, une ligne " + FSTART + "chemin/relatif" + FEND + ", le contenu complet du fichier, puis une ligne " + FDONE + ".";
  const listing = UPGRADE_FILES.map(p => FSTART + p + FEND + '\n' + current[p] + '\n' + FDONE).join('\n');
  const userMsg = "DEMANDE DE L'UTILISATEUR :\n" + demande + "\n\nFICHIERS ACTUELS :\n" + listing;

  let out;
  try { out = await completeForUpgrade(rules, userMsg); }
  catch (e) { return "Erreur lors de la génération du nouveau code (" + (e.message || e) + "). Je n'ai rien changé."; }

  const changed = {};
  for (const part of out.split(FSTART).slice(1)) {
    const nl = part.indexOf('\n'); if (nl < 0) continue;
    const path = part.slice(0, nl).replace(/=+\s*$/, '').trim();
    let body = part.slice(nl + 1);
    const end = body.lastIndexOf(FDONE); if (end >= 0) body = body.slice(0, end);
    body = body.replace(/^\s*```\w*\n|\n```\s*$/g, '').replace(/\s+$/, '') + '\n';
    if (!UPGRADE_FILES.includes(path)) continue;
    changed[path] = body;
  }
  if (!Object.keys(changed).length) return "Je n'ai reçu aucun fichier modifié valide. Je n'ai rien changé.";

  const MUST_KEEP = {
    'desktop/renderer.js': ['ameliorer_pc', 'pushSync', 'const TOOLS', 'async function runTool'],
    'desktop/main.js': ["'ai-claude'", "'ai-gemini'", "'pc-open-app'", "'sys-stats'"],
    'desktop/preload.js': ['aiBridge', 'pcBridge'],
    'desktop/index.html': ['renderer.js', 'chatlog']
  };
  for (const path in changed) {
    for (const k of (MUST_KEEP[path] || [])) {
      if (!changed[path].includes(k)) return "Le nouveau " + path + " perdait une partie essentielle (" + k + "). Je n'ai rien changé.";
    }
    if (path.endsWith('.js')) {
      try { new Function(changed[path]); }
      catch (e) { if (e instanceof SyntaxError) return "Le nouveau " + path + " contient une erreur de syntaxe (" + e.message + "). Je n'ai rien changé."; }
    }
  }

  for (const path in changed) {
    try { await pushFile(path, changed[path], 'Poupous PC : ' + demande.slice(0, 60)); }
    catch (e) { return "Échec de l'envoi de " + path + " sur GitHub (" + (e.message || e) + ")."; }
  }
  return "C'est envoyé : " + Object.keys(changed).length + " fichier(s) modifié(s). La nouvelle version se construit sur GitHub, ça prend 5 à 15 minutes. Retélécharge et réinstalle ensuite depuis le même lien.";
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
    "ameliorer_pc : modifie ton propre code et publie une nouvelle version sur GitHub. Ça prend 5 à 15 minutes et l'utilisateur doit retélécharger et réinstaller l'application ensuite ; dis-le toujours clairement.\n" +
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
  setRadarState('thinking');
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
    setRadarState('idle');
  }
  if (handsFree) speak(answer, () => { if (handsFree) startListening(); });
}

function switchPanel(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
}

// --- Voice ---
// Electron's bundled Chromium has no Google API key, so the built-in
// SpeechRecognition/webkitSpeechRecognition API silently fails (network
// error) every time. Recording audio and transcribing it via the Gemini
// API (which supports audio input) works reliably instead.
let handsFree = false;
let recognizing = false;
let micStream = null;

function isStopWord(t) { return /^(stop|arrête|arrete|arrête[- ]toi|arrete[- ]toi)\s*\.?$/i.test(t.trim()); }

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function recordAudio(ms) {
  if (!micStream) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some(d => d.kind === 'audioinput')) {
        throw new Error("aucun microphone détecté par Windows (vérifie qu'un micro est branché et activé)");
      }
    } catch (e) {
      if (e.message && e.message.includes('aucun microphone')) throw e;
    }
    micStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: true }),
      6000,
      "accès au micro refusé ou bloqué (vérifie que Windows autorise les applications de bureau à utiliser le micro, dans Paramètres > Confidentialité > Micro)"
    );
  }
  const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(micStream, { mimeType: mime });
  const chunks = [];
  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = (e) => reject(new Error((e.error && e.error.message) || "erreur d'enregistrement audio"));
  });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start();
  await new Promise((r) => setTimeout(r, ms));
  rec.stop();
  await withTimeout(stopped, 5000, "l'enregistrement audio ne s'est pas terminé correctement");
  return { blob: new Blob(chunks, { type: mime }), mime };
}

async function transcribeAudio(blob, mime, apiKey) {
  const base64 = await blobToBase64(blob);
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    const r = await window.aiBridge.gemini(apiKey, model, {
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: mime, data: base64 } },
        { text: 'Transcris exactement ce qui est dit en français. Réponds uniquement avec le texte transcrit, sans commentaire. Si rien de compréhensible n\'est dit, réponds avec une chaîne vide.' }
      ] }],
      generationConfig: { maxOutputTokens: 300 }
    });
    if (r.status === 200 && r.data) {
      const cand = (r.data.candidates || [])[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      return parts.filter(x => x.text).map(x => x.text).join(' ').trim();
    }
    lastErr = (r.data && r.data.error && r.data.error.message) || ('HTTP ' + r.status);
  }
  throw new Error(lastErr || 'transcription indisponible');
}

async function startListening() {
  if (recognizing || sending) return;
  const cfg = loadConfig();
  const sttKey = effectiveSttKey(cfg);
  if (!sttKey) {
    state.conversation.push({ role: 'assistant', content: "Il me faut une clé Gemini pour comprendre ta voix — renseigne-la dans l'onglet Cerveau, section Micro." });
    renderChat();
    if (handsFree) setHandsFree(false);
    return;
  }
  recognizing = true;
  $('mic-btn').classList.add('listening');
  setRadarState('listening');
  try {
    const { blob, mime } = await recordAudio(5000);
    const raw = await withTimeout(transcribeAudio(blob, mime, sttKey), 15000, 'la transcription a mis trop de temps à répondre');
    recognizing = false;
    $('mic-btn').classList.remove('listening');
    setRadarState('idle');
    if (!raw) { if (handsFree) startListening(); return; }
    if (handsFree && isStopWord(raw)) { setHandsFree(false); return; }
    let text = raw;
    if (handsFree) {
      const word = cfg.wakeWord.trim();
      if (word) {
        const re = new RegExp('^\\s*' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,]?\\s*', 'i');
        if (!re.test(text)) { startListening(); return; }
        text = text.replace(re, '').trim();
        if (!text) { startListening(); return; }
      }
    }
    $('chat-input').value = text;
    sendChat();
  } catch (e) {
    recognizing = false;
    $('mic-btn').classList.remove('listening');
    setRadarState('idle');
    state.conversation.push({ role: 'assistant', content: 'Micro indisponible : ' + (e.message || e) });
    renderChat();
    if (handsFree) setHandsFree(false);
  }
}

function speakBrowser(text, onDone) {
  try {
    if (!window.speechSynthesis) { setRadarState('idle'); if (onDone) onDone(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.onend = () => { setRadarState('idle'); if (onDone) onDone(); };
    u.onerror = () => { setRadarState('idle'); if (onDone) onDone(); };
    speechSynthesis.speak(u);
  } catch (e) { setRadarState('idle'); if (onDone) onDone(); }
}

async function speak(text, onDone) {
  if (!text) { if (onDone) onDone(); return; }
  setRadarState('speaking');
  const cfg = loadConfig();
  if (cfg.elevenKey && cfg.elevenVoice && window.voiceBridge) {
    try {
      const r = await window.voiceBridge.tts(cfg.elevenKey, cfg.elevenVoice, text);
      if (r.ok) {
        const audio = new Audio('data:audio/mpeg;base64,' + r.base64);
        audio.onended = () => { setRadarState('idle'); if (onDone) onDone(); };
        audio.onerror = () => { setRadarState('idle'); if (onDone) onDone(); };
        audio.play();
        return;
      }
    } catch (e) {}
  }
  speakBrowser(text, onDone);
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
  $('eleven-key').value = cfg.elevenKey;
  $('eleven-voice').value = cfg.elevenVoice;
  $('wake-word').value = cfg.wakeWord;
  $('stt-key').value = cfg.sttKeyRaw;
  $('stt-status-text').textContent = effectiveSttKey(cfg) ? 'Reconnaissance vocale activée.' : "Il faut une clé Gemini pour que Poupous comprenne ta voix.";
  $('eleven-status-text').textContent = (cfg.elevenKey && cfg.elevenVoice) ? 'Voix ElevenLabs activée.' : 'Sans clé, Poupous utilise la voix système du navigateur.';
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

  $('save-eleven').onclick = () => {
    const key = $('eleven-key').value.trim();
    const voice = $('eleven-voice').value.trim();
    saveElevenConfig(key, voice);
    $('eleven-status-text').textContent = (key && voice) ? 'Voix ElevenLabs activée.' : 'Sans clé, Poupous utilise la voix système du navigateur.';
  };
  $('wake-word').addEventListener('change', () => saveWakeWord($('wake-word').value.trim() || 'poupous'));

  $('save-stt').onclick = () => {
    saveSttKey($('stt-key').value.trim());
    $('stt-status-text').textContent = effectiveSttKey(loadConfig()) ? 'Reconnaissance vocale activée.' : "Il faut une clé Gemini pour que Poupous comprenne ta voix.";
  };

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

  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)) {
    $('mic-btn').disabled = true;
    $('mic-btn').title = 'Microphone indisponible';
    $('hf-switch').style.opacity = '.4';
    $('hf-switch').style.pointerEvents = 'none';
  } else {
    $('mic-btn').onclick = () => startListening();
    $('hf-switch').onclick = () => setHandsFree(!handsFree);
  }

  updateClock();
  setInterval(updateClock, 1000 * 30);
  updateRamGauge();
  setInterval(updateRamGauge, 4000);

  render();
  if (cfg.token) pullSync();
});
