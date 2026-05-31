const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  repos: [
    'anthropics/skills',
    'alirezarezvani/claude-skills',
    'OneWave-AI/claude-skills',
    'wondelai/skills'
  ],
  ttlMinutes: 60
};

function baseDir() {
  try {
    const electron = require('electron');
    const app = electron.app || (electron.remote && electron.remote.app);
    if (app && app.getPath) return app.getPath('userData');
  } catch (e) { /* not in electron */ }
  const dir = path.join(os.homedir(), '.skiller');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return dir;
}

function settingsPath() {
  return path.join(baseDir(), 'skiller-settings.json');
}

function cacheDir() {
  const dir = path.join(baseDir(), 'cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return dir;
}

function normalizeRepo(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const repos = Array.isArray(data.repos) ? data.repos.map(normalizeRepo).filter(Boolean) : DEFAULTS.repos.slice();
    return {
      repos: repos.length ? repos : DEFAULTS.repos.slice(),
      ttlMinutes: Number.isFinite(data.ttlMinutes) ? data.ttlMinutes : DEFAULTS.ttlMinutes
    };
  } catch (e) {
    const seeded = { repos: DEFAULTS.repos.slice(), ttlMinutes: DEFAULTS.ttlMinutes };
    save(seeded);
    return seeded;
  }
}

function save(settings) {
  const current = (function () { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (e) { return {}; } })();
  const repos = Array.isArray(settings.repos)
    ? Array.from(new Set(settings.repos.map(normalizeRepo).filter(Boolean)))
    : (current.repos || DEFAULTS.repos.slice());
  const next = {
    repos: repos,
    ttlMinutes: Number.isFinite(settings.ttlMinutes) ? settings.ttlMinutes : (current.ttlMinutes || DEFAULTS.ttlMinutes)
  };
  try { fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); } catch (e) { /* ignore */ }
  return next;
}

function addRepo(url) {
  const s = load();
  const norm = normalizeRepo(url);
  if (norm && s.repos.indexOf(norm) === -1) s.repos.push(norm);
  return save(s);
}

function removeRepo(url) {
  const s = load();
  const norm = normalizeRepo(url);
  s.repos = s.repos.filter(function (r) { return r !== norm; });
  return save(s);
}

module.exports = {
  DEFAULTS: DEFAULTS,
  baseDir: baseDir,
  settingsPath: settingsPath,
  cacheDir: cacheDir,
  load: load,
  save: save,
  addRepo: addRepo,
  removeRepo: removeRepo
};
