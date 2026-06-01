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

function claudeSkillsDir() {
  return path.join(os.homedir(), '.claude', 'skills');
}

function parseFrontmatter(text) {
  const out = {};
  if (!text || text.slice(0, 3) !== '---') return out;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return out;
  text.slice(3, end).split('\n').forEach(function (line) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return out;
}

function countFiles(dir) {
  let n = 0;
  try {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
      else n += 1;
    });
  } catch (e) { /* ignore */ }
  return n;
}

function scanClaudeCodeSkills() {
  const base = claudeSkillsDir();
  const out = [];
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return out; }
  entries.forEach(function (e) {
    if (!e.isDirectory() || e.name.charAt(0) === '.') return;
    const dir = path.join(base, e.name);
    const mdPath = path.join(dir, 'SKILL.md');
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(mdPath, 'utf8')); } catch (err) { return; }
    let stat = null;
    try { stat = fs.statSync(dir); } catch (err) { /* ignore */ }
    const name = fm.name || e.name;
    out.push({
      key: 'cc-disk:' + e.name,
      name: name,
      title: name,
      description: fm.description || '',
      category: fm.category || '',
      categoryLabel: fm.category || 'General',
      source: null,
      htmlUrl: '',
      target: 'code',
      path: dir,
      fileCount: countFiles(dir),
      installedAt: stat ? (stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs) : 0,
      external: true
    });
  });
  return out;
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
  const known = {};
  list.forEach(function (r) { if (r.target === 'code' && r.path) known[path.resolve(r.path)] = true; });
  const external = scanClaudeCodeSkills().filter(function (r) { return !known[path.resolve(r.path)]; });
  return list.concat(external).sort(function (a, b) { return (b.installedAt || 0) - (a.installedAt || 0); });
}

function uninstall(key) {
  if (typeof key === 'string' && key.indexOf('cc-disk:') === 0) {
    const dir = path.join(claudeSkillsDir(), key.slice('cc-disk:'.length));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    return { ok: true };
  }
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

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'];
const TEXT_EXT = ['md', 'markdown', 'mdx', 'txt', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'yaml', 'yml', 'py', 'sh', 'bash', 'zsh', 'xml', 'csv', 'tsv', 'toml', 'ini', 'cfg', 'conf', 'env', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cc', 'cpp', 'h', 'hpp', 'php', 'sql', 'lua', 'r', 'swift', 'gradle', 'dockerfile', 'gitignore', 'log'];
const MAX_TEXT = 800000;

function fileEntry(rel, buffer) {
  const lower = rel.toLowerCase();
  const base = lower.split('/').pop();
  const ext = base.indexOf('.') >= 0 ? base.split('.').pop() : '';
  const out = { rel: rel, ext: ext, size: buffer.length, type: 'binary', text: null, dataUrl: null };
  if (IMAGE_EXT.indexOf(ext) >= 0) {
    out.type = 'image';
    const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'ico' ? 'image/x-icon' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext));
    out.dataUrl = 'data:' + mime + ';base64,' + buffer.toString('base64');
  } else if (TEXT_EXT.indexOf(ext) >= 0 || ext === '' || base === 'license' || base === 'readme') {
    out.type = (ext === 'md' || ext === 'markdown' || ext === 'mdx') ? 'markdown' : (ext === 'html' || ext === 'htm' ? 'html' : 'text');
    out.text = buffer.length <= MAX_TEXT ? buffer.toString('utf8') : '(file too large to preview)';
  }
  return out;
}

function readDirFiles(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function (e) {
      const full = path.join(d, e.name);
      if (e.name === '.DS_Store' || e.name === 'Thumbs.db') return;
      if (e.isDirectory()) { if (e.name !== '.git') walk(full); }
      else {
        try {
          const rel = path.relative(dir, full).split(path.sep).join('/');
          out.push(fileEntry(rel, fs.readFileSync(full)));
        } catch (err) { /* ignore unreadable */ }
      }
    });
  })(dir);
  return out;
}

function sortFiles(files) {
  files.sort(function (a, b) {
    const am = /^skill\.md$/i.test(a.rel) ? 0 : 1;
    const bm = /^skill\.md$/i.test(b.rel) ? 0 : 1;
    if (am !== bm) return am - bm;
    const ad = a.rel.indexOf('/'), bd = b.rel.indexOf('/');
    if ((ad >= 0) !== (bd >= 0)) return ad >= 0 ? 1 : -1;
    return a.rel.toLowerCase().localeCompare(b.rel.toLowerCase());
  });
  return files;
}

async function getSkillFiles(skill) {
  let files;
  if (skill && skill.local && skill.path && fs.existsSync(skill.path)) {
    files = readDirFiles(skill.path);
  } else {
    const raw = await fetchSkillFiles(skill);
    files = raw
      .filter(function (f) { const b = f.rel.split('/').pop(); return b !== '.DS_Store' && b !== 'Thumbs.db'; })
      .map(function (f) { return fileEntry(f.rel, f.buffer); });
  }
  sortFiles(files);
  const md = files.find(function (f) { return /^skill\.md$/i.test(f.rel); });
  return { files: files, skillMd: (md && md.text) || '', skillMdRel: (md && md.rel) || null };
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
  // Claude installs are not tracked locally — they live on the account and are
  // read back via claude-install.listClaudeSkills().
  return { ok: true, path: dest, fileCount: files.length, settingsUrl: 'https://claude.ai/customize/skills' };
}

module.exports = {
  installToClaudeCode: installToClaudeCode,
  exportZipForClaude: exportZipForClaude,
  listInstalled: listInstalled,
  uninstall: uninstall,
  getSkillFiles: getSkillFiles
};
