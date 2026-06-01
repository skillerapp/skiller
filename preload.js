const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skiller', {
  getSettings: function () { return ipcRenderer.invoke('settings:get'); },
  addRepo: function (url) { return ipcRenderer.invoke('settings:addRepo', url); },
  removeRepo: function (url) { return ipcRenderer.invoke('settings:removeRepo', url); },
  getSkills: function (opts) { return ipcRenderer.invoke('skills:get', opts || {}); },
  installCode: function (skill) { return ipcRenderer.invoke('install:code', skill); },
  installClaude: function (skill) { return ipcRenderer.invoke('install:claude', skill); },
  listInstalled: function () { return ipcRenderer.invoke('installed:list'); },
  uninstall: function (key) { return ipcRenderer.invoke('installed:remove', key); },
  revealPath: function (p) { return ipcRenderer.invoke('reveal:path', p); },
  openExternal: function (url) { return ipcRenderer.invoke('open:external', url); }
});
