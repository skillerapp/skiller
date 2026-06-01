const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const settings = require('./src/main/settings');
const marketplace = require('./src/main/marketplace');
const install = require('./src/main/install');

function createWindow() {
  const win = new BrowserWindow({
    width: 1270,
    height: 720,
    minWidth: 1270,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'src/render', 'index.html'));
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
  if (res && res.path) shell.showItemInFolder(res.path);
  if (res && res.settingsUrl) shell.openExternal(res.settingsUrl);
  return res;
});

ipcMain.handle('installed:list', function () {
  return install.listInstalled();
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
