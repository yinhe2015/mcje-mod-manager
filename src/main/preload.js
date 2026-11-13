const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  loadMods: (path) => ipcRenderer.invoke('load-mods', path),
  toggleMod: (path, filename) => ipcRenderer.invoke('toggle-mod', path, filename),
  renameMod: (path, oldName, newName) => ipcRenderer.invoke('rename-mod', path, oldName, newName),
  reorderMods: (path, files) => ipcRenderer.invoke('reorder-mods', path, files),
  addPrefixes: (path, files) => ipcRenderer.invoke('add-prefixes', path, files),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openModLink: (type, name) => ipcRenderer.invoke('open-mod-link', type, name),
  getModLinks: (name) => ipcRenderer.invoke('get-mod-links', name),
  updateModPath: (path) => ipcRenderer.send('update-mod-path', path),
  onPathChanged: (callback) => ipcRenderer.on('path-changed', (event, path) => callback(path)),
  // 新增文件操作 API
  showFileInFolder: (filePath) => ipcRenderer.invoke('show-file-in-folder', filePath),
  deleteMod: (filePath) => ipcRenderer.invoke('delete-mod', filePath)
});
