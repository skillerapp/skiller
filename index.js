const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const settings = require('./src/main/settings');
const marketplace = require('./src/main/marketplace');

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
