const { contextBridge, ipcRenderer } = require('electron');
const { Titlebar, TitlebarColor } = require('custom-electron-titlebar');

function appBgHex() {
  const c = getComputedStyle(document.body).backgroundColor;
  const m = c && c.match(/\d+/g);
  if (!m) return '#F5F4EE';
  return '#' + m.slice(0, 3).map(function (n) { return ('0' + parseInt(n, 10).toString(16)).slice(-2); }).join('');
}

window.addEventListener('DOMContentLoaded', function () {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const bar = new Titlebar({
    backgroundColor: TitlebarColor.fromHex(appBgHex()),
    itemBackgroundColor: TitlebarColor.fromHex(mq.matches ? '#1D1C1A' : '#F4F3ED'),
    titleHorizontalAlignment: 'center',
    iconSize: 18,
    icon: '../img/icon.svg',
    maximizable: true
  });
  mq.addEventListener('change', function () {
    requestAnimationFrame(function () {
      bar.updateBackground(TitlebarColor.fromHex(appBgHex()));
      bar.updateItemBGColor(TitlebarColor.fromHex(mq.matches ? '#1D1C1A' : '#F4F3ED'));
    });
  });
});

contextBridge.exposeInMainWorld('skiller', {
  getSettings: function () { return ipcRenderer.invoke('settings:get'); },
  addRepo: function (url) { return ipcRenderer.invoke('settings:addRepo', url); },
  removeRepo: function (url) { return ipcRenderer.invoke('settings:removeRepo', url); },
  getSkills: function (opts) { return ipcRenderer.invoke('skills:get', opts || {}); },
  installCode: function (skill) { return ipcRenderer.invoke('install:code', skill); },
  installClaude: function (skill) { return ipcRenderer.invoke('install:claude', skill); },
  listInstalled: function () { return ipcRenderer.invoke('installed:list'); },
  getSkillFiles: function (skill) { return ipcRenderer.invoke('skill:files', skill); },
  uninstall: function (key) { return ipcRenderer.invoke('installed:remove', key); },
  revealPath: function (p) { return ipcRenderer.invoke('reveal:path', p); },
  listClaudeSkills: function () { return ipcRenderer.invoke('claude:listSkills'); },
  claudeLogin: function () { return ipcRenderer.invoke('claude:login'); },
  claudeAccountStatus: function () { return ipcRenderer.invoke('claude:accountStatus'); },
  claudeSignOut: function () { return ipcRenderer.invoke('claude:signOut'); },
  onClaudeStatus: function (cb) { ipcRenderer.on('claude:status', function (e, data) { cb(data); }); },
  openExternal: function (url) { return ipcRenderer.invoke('open:external', url); }
});
