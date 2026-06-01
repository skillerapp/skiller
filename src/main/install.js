const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');

const USER_AGENT = 'Skiller-App';

function registryPath() {
  return path.join(settings.baseDir(), 'installed.json');
}

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function writeRegistry(list) {
  try { fs.writeFileSync(registryPath(), JSON.stringify(list, null, 2)); } catch (e) { /* ignore */ }
}

function recordKey(name, target) {
  return safeName(name) + '|' + target;
}

function recordInstall(skill, target, result) {
  const list = readRegistry();
  const key = recordKey(skill.name, target);
  const record = {
    key: key,
    name: skill.name,
    title: skill.title || skill.name,
    description: skill.description || '',
    category: skill.category || '',
    categoryLabel: skill.categoryLabel || 'General',
    source: skill.source || null,
    htmlUrl: skill.htmlUrl || '',
    target: target,
    path: result.path,
    fileCount: result.fileCount || 0,
    installedAt: Date.now()
  };
  const next = list.filter(function (r) { return r.key !== key; });
  next.push(record);
  writeRegistry(next);
  return record;
}

function listInstalled() {
  const list = readRegistry();
  let changed = false;
  list.forEach(function (r) {
    let exists = false;
    try { exists = fs.existsSync(r.path); } catch (e) { exists = false; }
    if (r.missing !== !exists) { r.missing = !exists; changed = true; }
  });
  if (changed) writeRegistry(list);
  return list.slice().sort(function (a, b) { return (b.installedAt || 0) - (a.installedAt || 0); });
}

function uninstall(key) {
  const list = readRegistry();
  const record = list.find(function (r) { return r.key === key; });
  if (record) {
    try {
      if (record.target === 'code') fs.rmSync(record.path, { recursive: true, force: true });
      else if (record.target === 'claude') fs.rmSync(record.path, { force: true });
    } catch (e) { /* ignore */ }
  }
  writeRegistry(list.filter(function (r) { return r.key !== key; }));
  return { ok: true };
}

function fetchBuffer(url, depth) {
  depth = depth || 0;
  return new Promise(function (resolve, reject) {
    if (depth > 5) { reject(new Error('too many redirects')); return; }
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, function (res) {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        resolve(fetchBuffer(next, depth + 1));
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code)); return; }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
    }).on('error', reject).setTimeout(60000, function () { this.destroy(new Error('timeout')); });
  });
}

// Extract every file under `subdir` from a GitHub codeload tar.gz.
// Returns [{ rel, buffer }] where rel is the path relative to subdir.
function extractSubtree(gzBuf, subdir) {
  const data = zlib.gunzipSync(gzBuf);
  const want = subdir ? subdir.replace(/\/+$/, '') + '/' : null;
  const out = [];
  let off = 0;
  while (off + 512 <= data.length) {
    const block = data.subarray(off, off + 512);
    let zero = true;
    for (let i = 0; i < 512; i++) { if (block[i] !== 0) { zero = false; break; } }
    if (zero) break;
    let name = block.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '');
    const prefix = block.toString('utf8', 345, 500).replace(/\0[\s\S]*$/, '');
    if (prefix) name = prefix + '/' + name;
    const type = String.fromCharCode(block[156]);
    const sizeField = block.toString('utf8', 124, 136).replace(/[^0-7]/g, '');
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    off += 512;
    if (type === '0' || type === ' ' || type === '') {
      const slash = name.indexOf('/');
      const rel = slash >= 0 ? name.slice(slash + 1) : '';
      if (rel && (!want || rel.indexOf(want) === 0)) {
        const sub = want ? rel.slice(want.length) : rel;
        if (sub) out.push({ rel: sub, buffer: data.subarray(off, off + size) });
      }
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

async function fetchSkillFiles(skill) {
  const owner = skill.source.owner, repo = skill.source.repo, branch = skill.source.branch || 'main';
  const buf = await fetchBuffer('https://codeload.github.com/' + owner + '/' + repo + '/tar.gz/refs/heads/' + encodeURIComponent(branch));
  const files = extractSubtree(buf, skill.path || '');
  if (!files.length) throw new Error('no files found for skill');
  return files;
}

function safeName(name) {
  return String(name || 'skill').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

// ---- Install to Claude Code: ~/.claude/skills/{name}/ ----
async function installToClaudeCode(skill) {
  const files = await fetchSkillFiles(skill);
  const name = safeName(skill.name);
  const dest = path.join(os.homedir(), '.claude', 'skills', name);
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.buffer);
  }
  const result = { ok: true, path: dest, fileCount: files.length };
  recordInstall(skill, 'code', result);
  return result;
}

// ---- Minimal store-only ZIP writer (no deps) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.buffer;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}

// ---- "Install to Claude" (claude.ai): zip the skill, save it, return path ----
// There is no public/ToS-safe API for consumer-account skills, so we package
// the skill and hand it to the user to upload (the app opens the settings page).
async function exportZipForClaude(skill) {
  const files = await fetchSkillFiles(skill);
  const name = safeName(skill.name);
  const zip = makeZip(files.map(function (f) { return { name: name + '/' + f.rel, buffer: f.buffer }; }));
  const dir = path.join(os.homedir(), 'Downloads');
  let dest = path.join(dir, name + '.zip');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { dest = path.join(os.tmpdir(), name + '.zip'); }
  fs.writeFileSync(dest, zip);
  const result = { ok: true, path: dest, fileCount: files.length, settingsUrl: 'https://claude.ai/settings/capabilities' };
  recordInstall(skill, 'claude', result);
  return result;
}

module.exports = {
  installToClaudeCode: installToClaudeCode,
  exportZipForClaude: exportZipForClaude,
  listInstalled: listInstalled,
  uninstall: uninstall
};
