const { BrowserWindow, session } = require('electron');

const SKILLS_URL = 'https://claude.ai/customize/skills';
const CLAUDE_PARTITION = 'persist:claude';

let win = null;
let wired = false;
let pendingZip = null;
let reporter = null;

function log() {
  console.log.apply(console, ['[claude-install]'].concat(Array.prototype.slice.call(arguments)));
}

function report(phase, message) {
  try { if (reporter && !reporter.isDestroyed()) reporter.send('claude:status', { phase: phase, message: message || '' }); } catch (e) { /* ignore */ }
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// loadURL that never hangs the flow — resolves on load or after a timeout.
function loadURLSafe(w, url, ms) {
  return Promise.race([w.loadURL(url).catch(function () {}), wait(ms || 15000)]);
}

// --- page scripts -----------------------------------------------------------

const OBSERVER_JS = '(function(){' +
  'if(window.__skillerObs)return true;' +
  'function fire(){console.log("[skiller] FILE_INPUT_READY");if(window.__skillerObs){window.__skillerObs.disconnect();window.__skillerObs=null;}}' +
  'function has(n){return n&&n.nodeType===1&&((n.matches&&n.matches("input[type=file]"))||(n.querySelector&&n.querySelector("input[type=file]")));}' +
  'var obs=new MutationObserver(function(m){for(var i=0;i<m.length;i++){var a=m[i].addedNodes;for(var j=0;j<a.length;j++){if(has(a[j])){fire();return;}}}});' +
  'if(document.querySelector("input[type=file]")){fire();}else{obs.observe(document.documentElement,{childList:true,subtree:true});window.__skillerObs=obs;}' +
  'return true;})();';

// Click through: + Add skill -> Create skill -> Upload a skill
const DRIVE_JS = '(async function(){' +
  'function all(s){return Array.prototype.slice.call(document.querySelectorAll(s));}' +
  'function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}' +
  'function byText(re){var sels=["button","a","[role=menuitem]","[role=button]","[role=option]"];for(var i=0;i<sels.length;i++){var e=all(sels[i]);for(var j=0;j<e.length;j++){var t=(e[j].innerText||e[j].textContent||"").trim();if(t&&re.test(t)&&vis(e[j]))return e[j];}}return null;}' +
  'function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}' +
  'async function waitFor(fn,to){var s=Date.now();to=to||7000;while(Date.now()-s<to){var v=fn();if(v)return v;await wait(150);}return null;}' +
  'function hover(el){["pointerover","pointerenter","mouseover","mouseenter","mousemove"].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,view:window}));});}' +
  'function click(el){if(el.scrollIntoView)el.scrollIntoView({block:"center"});["pointerdown","mousedown","pointerup","mouseup","click"].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});}' +
  'function dump(){var o=[];all("button,[role=menuitem],a").forEach(function(el){if(vis(el)){var t=(el.innerText||"").trim();if(t)o.push(t);}});console.log("[skiller] BUTTONS "+JSON.stringify(o.slice(0,50)));}' +
  'var add=await waitFor(function(){return byText(/add skill/i)||byText(/^\\s*\\+\\s*$/);});' +
  'if(!add){console.log("[skiller] DRIVE_FAIL add-skill");dump();return;}' +
  'click(add);await wait(350);' +
  'var create=await waitFor(function(){return byText(/create skill/i);},5000);' +
  'if(create){hover(create);await wait(250);click(create);await wait(350);}' +
  'var up=await waitFor(function(){return byText(/upload a skill|upload skill/i);},5000);' +
  'if(!up){console.log("[skiller] DRIVE_FAIL upload-skill");dump();return;}' +
  'hover(up);click(up);console.log("[skiller] DRIVE_UPLOAD_CLICKED");' +
  '})();';

// After the file is attached, click the confirm button and watch for result.
const SUBMIT_JS = '(async function(){' +
  'function all(s){return Array.prototype.slice.call(document.querySelectorAll(s));}' +
  'function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}' +
  'function btnByText(re){var e=all("button,[role=button]");for(var i=0;i<e.length;i++){var t=(e[i].innerText||"").trim();if(t&&re.test(t)&&vis(e[i])&&!e[i].disabled)return e[i];}return null;}' +
  'function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}' +
  'await wait(600);' +
  'var btn=null,s=Date.now();while(Date.now()-s<6000){btn=btnByText(/^(add skill|create skill|upload skill|upload|add|create|install|save|confirm|done)$/i);if(btn)break;await wait(200);}' +
  'if(btn){["pointerdown","mousedown","pointerup","mouseup","click"].forEach(function(t){btn.dispatchEvent(new MouseEvent(t,{bubbles:true,view:window}));});console.log("[skiller] SUBMIT_CLICKED "+(btn.innerText||"").trim());}else{console.log("[skiller] SUBMIT_NOT_FOUND");}' +
  'var t=Date.now();while(Date.now()-t<9000){var err=null;all("*").some(function(el){if(!vis(el))return false;var tx=(el.innerText||"");if(tx.length<160&&/already in use|failed|error|invalid|too large|not allowed/i.test(tx)){err=tx.trim();return true;}return false;});if(err){console.log("[skiller] RESULT_ERROR "+err);return;}await wait(300);}' +
  'console.log("[skiller] RESULT_OK");' +
  '})();';

const SCRAPE_JS = '(function(){' +
  'function all(s){return Array.prototype.slice.call(document.querySelectorAll(s));}' +
  'function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>4;}' +
  'var names=[];' +
  'all("main h1,main h2,main h3,main h4,main [class*=title],main [class*=name],main a[href*=skill]").forEach(function(el){var t=(el.innerText||"").trim();if(t&&t.length<60&&vis(el))names.push(t);});' +
  'var seen={},out=[];names.forEach(function(n){var k=n.toLowerCase();if(!seen[k]){seen[k]=1;out.push(n);}});' +
  'console.log("[skiller] SCRAPED "+JSON.stringify(out.slice(0,80)));' +
  'return out;' +
  '})();';

// --- window / CDP -----------------------------------------------------------

function injectObserver(w) {
  w.webContents.executeJavaScript(OBSERVER_JS, true).catch(function () {});
}

async function setFileOnInput(w) {
  if (!pendingZip) return;
  const dbg = w.webContents.debugger;
  const zip = pendingZip;
  try {
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const q = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (!q || !q.nodeIds || !q.nodeIds.length) { log('no file input found'); return; }
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [zip], nodeId: q.nodeIds[q.nodeIds.length - 1] });
    pendingZip = null;
    log('zip attached; submitting…');
    report('submitting', 'Finishing up…');
    w.webContents.executeJavaScript(SUBMIT_JS, true).catch(function () {});
  } catch (e) {
    log('attach error:', e && e.message);
  }
}

function consoleText(event, level, message) {
  if (event && typeof event.message === 'string') return event.message;
  return typeof message === 'string' ? message : '';
}

function onPageMessage(msg) {
  if (msg.indexOf('[skiller] FILE_INPUT_READY') !== -1) { setFileOnInput(win); return; }
  if (msg.indexOf('[skiller] DRIVE_FAIL') !== -1) {
    log('auto-drive failed:', msg);
    report('manual', 'Finish the upload in the Claude window');
    if (win) win.show();
    return;
  }
  if (msg.indexOf('[skiller] SUBMIT_NOT_FOUND') !== -1) {
    report('manual', 'Confirm the upload in the Claude window');
    if (win) win.show();
    return;
  }
  if (msg.indexOf('[skiller] RESULT_ERROR') !== -1) {
    const text = msg.replace('[skiller] RESULT_ERROR', '').trim();
    log('result error:', text);
    report('error', text || 'Claude rejected the skill');
    if (win) win.show();
    return;
  }
  if (msg.indexOf('[skiller] RESULT_OK') !== -1) {
    log('install complete');
    report('done', 'Installed to Claude');
    return;
  }
  if (msg.indexOf('[skiller] BUTTONS') !== -1 || msg.indexOf('[skiller] SCRAPED') !== -1) { log('PAGE', msg); }
}

function setupDebugger(w) {
  const dbg = w.webContents.debugger;
  try { dbg.attach('1.3'); } catch (e) { /* already attached */ }
  dbg.sendCommand('DOM.enable').catch(function () {});
  wired = true;
}

function getWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: false,
    title: 'Claude',
    autoHideMenuBar: true,
    webPreferences: { partition: CLAUDE_PARTITION }
  });
  wired = false;
  win.webContents.on('console-message', function (event, level, message) {
    const msg = consoleText(event, level, message);
    if (msg.indexOf('[skiller]') !== -1) onPageMessage(msg);
  });
  win.on('closed', function () { win = null; pendingZip = null; wired = false; });
  return win;
}

// Login is determined by the presence of the claude.ai session cookie — robust
// regardless of what page/URL is shown when logged out.
async function isLoggedIn() {
  try {
    const ses = session.fromPartition(CLAUDE_PARTITION);
    const cookies = await ses.cookies.get({ url: 'https://claude.ai/' });
    return cookies.some(function (c) { return /sessionkey|session_key/i.test(c.name) && c.value; });
  } catch (e) { log('cookie check error', e && e.message); return false; }
}

async function waitForLogin(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < (timeoutMs || 180000)) {
    if (await isLoggedIn()) return true;
    await wait(900);
  }
  return false;
}

async function ensureSkillsPage(w, opts) {
  if (!(await isLoggedIn())) {
    if (opts && opts.silent) return false;
    report('login', 'Sign in to Claude to continue');
    await loadURLSafe(w, 'https://claude.ai/login');
    w.show();
    const ok = await waitForLogin(180000);
    if (!ok) return false;
    w.hide();
  }
  await loadURLSafe(w, SKILLS_URL);
  return true;
}

// --- public API -------------------------------------------------------------

async function installToClaude(zipPath, sender) {
  reporter = sender || null;
  const w = getWindow();
  if (!wired) setupDebugger(w);
  pendingZip = zipPath;
  report('opening', 'Opening Claude…');
  const ready = await ensureSkillsPage(w, { silent: false });
  if (!ready) { report('error', 'Sign-in required'); pendingZip = null; return { ok: false, needLogin: true }; }
  report('installing', 'Installing to Claude…');
  injectObserver(w);
  w.webContents.executeJavaScript(DRIVE_JS, true).catch(function () {});
  return { ok: true, started: true };
}

// Pull skills out of an arbitrary API JSON: find arrays whose elements are
// mostly objects with a name/title field; capture name + description.
function harvestSkills(node, out, depth) {
  depth = depth || 0;
  if (!node || depth > 7) return;
  if (Array.isArray(node)) {
    const named = node.filter(function (e) { return e && typeof e === 'object' && typeof (e.name || e.title || e.display_name || e.displayName) === 'string'; });
    if (named.length && named.length >= node.length * 0.5) {
      named.forEach(function (e) {
        const n = (e.name || e.title || e.display_name || e.displayName).trim();
        const d = (typeof e.description === 'string' ? e.description : (typeof e.summary === 'string' ? e.summary : '')) || '';
        if (n && n.length < 80) out.push({ name: n, description: d.trim() });
      });
    }
    node.forEach(function (e) { harvestSkills(e, out, depth + 1); });
    return;
  }
  if (typeof node === 'object') { Object.keys(node).forEach(function (k) { harvestSkills(node[k], out, depth + 1); }); }
}

async function listClaudeSkills() {
  log('listClaudeSkills ENTER');
  const w = getWindow();
  if (!wired) setupDebugger(w);
  const dbg = w.webContents.debugger;

  // Load the page FIRST so the debugger has a live target (enabling Network
  // before any page exists hangs forever).
  log('listClaudeSkills: loading skills page…');
  const ready = await ensureSkillsPage(w, { silent: true });
  log('listClaudeSkills: ready=' + ready + ' url=' + w.webContents.getURL());
  if (!ready) return { needLogin: true, skills: [] };

  const hits = [];
  const onMsg = function (event, method, params) {
    if (method !== 'Network.responseReceived') return;
    try {
      const r = params.response || {};
      const url = r.url || '';
      const mime = r.mimeType || '';
      if (/json/i.test(mime) && /skill|capabilit/i.test(url)) hits.push({ id: params.requestId, url: url });
    } catch (e) { /* ignore */ }
  };
  dbg.on('message', onMsg);
  try {
    log('listClaudeSkills: enabling Network…');
    await Promise.race([dbg.sendCommand('Network.enable').catch(function () {}), wait(3000)]);
    log('listClaudeSkills: reloading to capture skills fetch…');
    await loadURLSafe(w, SKILLS_URL);
    await wait(2800);
    log('listClaudeSkills: captured ' + hits.length + ' candidate response(s)');

    let names = [];
    for (let i = 0; i < hits.length; i++) {
      try {
        const body = await Promise.race([dbg.sendCommand('Network.getResponseBody', { requestId: hits[i].id }), wait(4000)]);
        if (!body || typeof body.body !== 'string') continue;
        const txt = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const data = JSON.parse(txt);
        const before = names.length;
        harvestSkills(data, names);
        log('skills endpoint', hits[i].url, '(+' + (names.length - before) + ' skills)');
      } catch (e) { /* response gone or not json */ }
    }
    log('network skills:', JSON.stringify(names.slice(0, 60)));

    if (!names.length) {
      try {
        const scraped = await w.webContents.executeJavaScript(SCRAPE_JS, true);
        (scraped || []).forEach(function (n) { names.push({ name: n, description: '' }); });
      } catch (e) { log('scrape error', e && e.message); }
      log('fallback scrape names:', JSON.stringify(names.slice(0, 60)));
    }

    const seen = {}, out = [];
    names.forEach(function (s) { const k = (s.name || '').toLowerCase(); if (k && !seen[k]) { seen[k] = 1; out.push(s); } });
    return { needLogin: false, skills: out };
  } finally {
    try { dbg.removeListener('message', onMsg); } catch (e) { /* ignore */ }
  }
}

async function ensureLogin() {
  const w = getWindow();
  if (!wired) setupDebugger(w);
  const ok = await ensureSkillsPage(w, { silent: false });
  return { ok: ok };
}

async function accountStatus() {
  try {
    const ses = session.fromPartition(CLAUDE_PARTITION);
    const cookies = await ses.cookies.get({ url: 'https://claude.ai/' });
    log('accountStatus cookies: ' + cookies.map(function (c) { return c.name; }).join(', '));
  } catch (e) { /* ignore */ }
  const loggedIn = await isLoggedIn();
  log('accountStatus: loggedIn=' + loggedIn);
  return { loggedIn: loggedIn };
}

async function signOut() {
  try {
    const ses = session.fromPartition(CLAUDE_PARTITION);
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem', 'shadercache'] });
    await ses.clearCache();
    await ses.flushStorageData();
    log('signOut: storage cleared');
  } catch (e) { log('signOut error', e && e.message); }
  if (win && !win.isDestroyed()) { await loadURLSafe(win, 'https://claude.ai/login'); win.hide(); }
  return { ok: true };
}

module.exports = {
  installToClaude: installToClaude,
  listClaudeSkills: listClaudeSkills,
  ensureLogin: ensureLogin,
  accountStatus: accountStatus,
  signOut: signOut
};
