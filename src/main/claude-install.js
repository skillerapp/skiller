const { BrowserWindow } = require('electron');

const SKILLS_URL = 'https://claude.ai/customize/skills';

let win = null;
let pendingZip = null;
let wired = false;

function log() {
  console.log.apply(console, ['[claude-install]'].concat(Array.prototype.slice.call(arguments)));
}

// Watch the page for the "Upload a skill" file <input> appearing, then signal
// the main process (via a console marker) so we can drop our zip onto it.
const OBSERVER_JS = '(function(){' +
  'if(window.__skillerObs)return true;' +
  'function fire(){console.log("[skiller] FILE_INPUT_READY");if(window.__skillerObs){window.__skillerObs.disconnect();window.__skillerObs=null;}}' +
  'function has(n){return n&&n.nodeType===1&&((n.matches&&n.matches("input[type=file]"))||(n.querySelector&&n.querySelector("input[type=file]")));}' +
  'var obs=new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){var a=muts[i].addedNodes;for(var j=0;j<a.length;j++){if(has(a[j])){fire();return;}}}});' +
  'obs.observe(document.documentElement,{childList:true,subtree:true});' +
  'window.__skillerObs=obs;return true;})();';

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
    if (!q || !q.nodeIds || !q.nodeIds.length) return;
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [zip], nodeId: q.nodeIds[q.nodeIds.length - 1] });
    pendingZip = null;
    log('skill file delivered to Claude');
  } catch (e) {
    log('error delivering file:', e && e.message);
  }
}

function consoleText(event, level, message) {
  if (event && typeof event.message === 'string') return event.message;
  return typeof message === 'string' ? message : '';
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
    title: 'Install to Claude',
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:claude' }
  });
  wired = false;
  win.webContents.on('console-message', function (event, level, message) {
    if (consoleText(event, level, message).indexOf('[skiller] FILE_INPUT_READY') !== -1) setFileOnInput(win);
  });
  win.webContents.on('did-finish-load', function () { if (pendingZip) injectObserver(win); });
  win.on('closed', function () { win = null; pendingZip = null; wired = false; });
  return win;
}

async function installToClaude(zipPath) {
  const w = getWindow();
  pendingZip = zipPath;
  if (!wired) setupDebugger(w);
  try { await w.loadURL(SKILLS_URL); } catch (e) { log('load error', e && e.message); }
  injectObserver(w);
  w.show();
  w.focus();
  return { ok: true, opened: true };
}

module.exports = { installToClaude: installToClaude };
