const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skiller', {
  getSettings: function () { return ipcRenderer.invoke('settings:get'); },
  addRepo: function (url) { return ipcRenderer.invoke('settings:addRepo', url); },
  removeRepo: function (url) { return ipcRenderer.invoke('settings:removeRepo', url); },
  getSkills: function (opts) { return ipcRenderer.invoke('skills:get', opts || {}); },
  openExternal: function (url) { return ipcRenderer.invoke('open:external', url); }
});
