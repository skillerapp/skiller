const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { setupTitlebar, attachTitlebarToWindow } = require('custom-electron-titlebar/main');
const settings = require('./src/main/settings');
const marketplace = require('./src/main/marketplace');
const install = require('./src/main/install');
const claudeInstall = require('./src/main/claude-install');

setupTitlebar();

if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]));
} else {
  Menu.setApplicationMenu(null);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1270,
    height: 720,
    minWidth: 1270,
    minHeight: 720,
    titleBarStyle: 'hidden',
    backgroundColor: '#1D1C1A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src/render', 'index.html'));
  attachTitlebarToWindow(win);

  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', function (e, url) {
    if (!/^file:\/\//.test(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
}

ipcMain.handle('settings:get', function () {
  return settings.load();
});

ipcMain.handle('settings:addRepo', function (e, url) {
  return settings.addRepo(url);
});

ipcMain.handle('settings:removeRepo', function (e, url) {
  return settings.removeRepo(url);
});

ipcMain.handle('skills:get', async function (e, opts) {
  opts = opts || {};
  const s = settings.load();
  return marketplace.aggregate(s.repos, {
    cacheDir: settings.cacheDir(),
    ttlMs: (s.ttlMinutes || 60) * 60000,
    force: !!opts.force
  });
});

ipcMain.handle('install:code', async function (e, skill) {
  return install.installToClaudeCode(skill);
});

ipcMain.handle('install:claude', async function (e, skill) {
  const res = await install.exportZipForClaude(skill);
  if (res && res.path) await claudeInstall.installToClaude(res.path, e.sender);
  return res;
});

ipcMain.handle('claude:listSkills', async function () {
  console.log('[claude-install] IPC claude:listSkills received');
  try {
    return await claudeInstall.listClaudeSkills();
  } catch (e) {
    console.log('[claude-install] listSkills threw:', e && e.message);
    return { needLogin: false, skills: [] };
  }
});

ipcMain.handle('claude:login', async function () {
  return claudeInstall.ensureLogin();
});

ipcMain.handle('claude:accountStatus', async function () {
  return claudeInstall.accountStatus();
});

ipcMain.handle('claude:signOut', async function () {
  return claudeInstall.signOut();
});

ipcMain.handle('installed:list', function () {
  return install.listInstalled();
});

ipcMain.handle('skill:files', async function (e, skill) {
  return install.getSkillFiles(skill);
});

ipcMain.handle('installed:remove', function (e, key) {
  return install.uninstall(key);
});

ipcMain.handle('reveal:path', function (e, p) {
  if (typeof p === 'string' && p) shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('open:external', function (e, url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return true;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
