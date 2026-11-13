const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const AdmZip = require('adm-zip');

log.initialize();
log.info('App starting...');

let mainWindow;
let currentModPath = '';

function createMenu() {
  const isMac = process.platform === 'darwin';
  
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开mods文件夹',
          click: async () => {
            if (currentModPath) {
              await shell.openPath(currentModPath);
            } else {
              const result = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory']
              });
              if (!result.canceled && result.filePaths[0]) {
                currentModPath = result.filePaths[0];
                mainWindow.webContents.send('path-changed', currentModPath);
                await shell.openPath(currentModPath);
              }
            }
          }
        },
        ...(isMac ? [] : [
          { type: 'separator' },
          {
            label: '退出',
            accelerator: 'Alt+F4',
            click: () => app.quit()
          }
        ])
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用方法',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '使用方法',
              message: 'MCJE Mod Manager 使用指南',
              detail: `1. 点击「选择 Mod 文件夹」按钮，选择游戏的 mods 文件夹
2. 勾选/取消勾选 Mod 名称前的复选框来启用/禁用 Mod
3. 拖拽 Mod 可以调整加载顺序（通过数字前缀控制）
4. 点击 🔗 按钮可以在 MC百科、Modrinth、CurseForge 搜索该 Mod
5. 点击「添加数字前缀」可以自动为所有 Mod 加上排序前缀
💡 提示：禁用后的 Mod 文件名会添加 .disabled 后缀`
            });
          }
        },
        {
          label: '显示/隐藏开发工具',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow.webContents.isDevToolsOpened()) {
              mainWindow.webContents.closeDevTools();
            } else {
              mainWindow.webContents.openDevTools();
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../../assets/icon.png')
  });

  createMenu();
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function extractVersion(filename) {
  const match = filename.match(/(\d+\.\d+(?:\.\d+)?(?:\-\d+)?)/);
  return match ? match[1] : '';
}

function sortMods(mods) {
  return mods.sort((a, b) => {
    const numA = parseInt(a.namePrefix) || 0;
    const numB = parseInt(b.namePrefix) || 0;
    return numA - numB;
  });
}

function getMaxPrefixLength(count) {
  return String(count).length;
}

// 解析简单的 TOML 格式（用于 Forge/NeoForge mods.toml）
function parseSimpleToml(content) {
  const result = { mods: [] };
  let currentMod = null;
  let inModsArray = false;
  
  const lines = content.split('\n');
  for (let line of lines) {
    line = line.trim();
    
    if (line === '[[mods]]') {
      if (currentMod) result.mods.push(currentMod);
      currentMod = {};
      inModsArray = true;
      continue;
    }
    
    if (line.startsWith('[') && !line.startsWith('[[')) {
      if (currentMod) result.mods.push(currentMod);
      currentMod = null;
      inModsArray = false;
      continue;
    }
    
    if (inModsArray && currentMod && line.includes('=')) {
      const eqIdx = line.indexOf('=');
      const key = line.substring(0, eqIdx).trim();
      let value = line.substring(eqIdx + 1).trim();
      
      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      currentMod[key] = value;
    }
  }
  
  if (currentMod) result.mods.push(currentMod);
  return result;
}

// 安全解析 JSON，处理控制字符
function safeParseJson(content) {
  try {
    return JSON.parse(content);
  } catch (e) {
    try {
      // 移除无效的控制字符（保留换行、回车、制表符）
      const cleaned = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      return JSON.parse(cleaned);
    } catch (e2) {
      log.warn('Failed to parse JSON even after cleaning:', e2.message);
      return null;
    }
  }
}

// 从 jar 文件读取模组元数据
function readModMetadata(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries();
    
    // 1. 尝试读取 quilt.mod.json (Quilt) - 优先检测
    const quiltEntry = entries.find(e => e.entryName === 'quilt.mod.json');
    if (quiltEntry) {
      try {
        const content = zip.readAsText(quiltEntry);
        const modJson = safeParseJson(content);
        if (modJson) {
          const quiltLoader = modJson.quilt_loader || {};
          return {
            id: quiltLoader.id || '',
            name: quiltLoader.metadata?.name || quiltLoader.id || '',
            version: quiltLoader.version || '',
            description: quiltLoader.metadata?.description || '',
            authors: quiltLoader.metadata?.contributors ? Object.keys(quiltLoader.metadata.contributors).join(', ') : '',
            loader: 'quilt'
          };
        }
      } catch (e) {
        log.warn('Failed to parse quilt.mod.json:', e);
      }
    }
    
    // 2. 尝试读取 fabric.mod.json (Fabric)
    const fabricEntry = entries.find(e => e.entryName === 'fabric.mod.json');
    if (fabricEntry) {
      try {
        const content = zip.readAsText(fabricEntry);
        const modJson = safeParseJson(content);
        if (modJson) {
          return {
            id: modJson.id || '',
            name: modJson.name || modJson.id || '',
            version: modJson.version || '',
            description: modJson.description || '',
            authors: Array.isArray(modJson.authors) ? modJson.authors.join(', ') : (modJson.authors || ''),
            loader: 'fabric'
          };
        }
      } catch (e) {
        log.warn('Failed to parse fabric.mod.json:', e);
      }
    }
    
    // 3. 尝试读取 neoforge.mods.toml (NeoForge) - NeoForge 特有
    const neoforgeTomlEntry = entries.find(e => e.entryName === 'META-INF/neoforge.mods.toml');
    if (neoforgeTomlEntry) {
      try {
        const content = zip.readAsText(neoforgeTomlEntry);
        const parsed = parseSimpleToml(content);
        if (parsed.mods && parsed.mods.length > 0) {
          const mod = parsed.mods[0];
          return {
            id: mod.modId || '',
            name: mod.displayName || mod.modId || '',
            version: mod.version || '',
            description: mod.description || '',
            authors: mod.authors || '',
            loader: 'neoforge'
          };
        }
      } catch (e) {
        log.warn('Failed to parse neoforge.mods.toml:', e);
      }
    }
    
    // 4. 尝试读取 META-INF/mods.toml (Forge / NeoForge兼容模式)
    const tomlEntry = entries.find(e => e.entryName === 'META-INF/mods.toml');
    if (tomlEntry) {
      try {
        const content = zip.readAsText(tomlEntry);
        const parsed = parseSimpleToml(content);
        if (parsed.mods && parsed.mods.length > 0) {
          const mod = parsed.mods[0];
          // 通过 modLoader 字段区分 Forge 和 NeoForge
          let loader = 'forge';
          if (mod.modLoader && mod.modLoader.includes('neoforge')) {
            loader = 'neoforge';
          } else if (mod.loader === 'neoforge') {
            loader = 'neoforge';
          }
          return {
            id: mod.modId || '',
            name: mod.displayName || mod.modId || '',
            version: mod.version || '',
            description: mod.description || '',
            authors: mod.authors || '',
            loader: loader
          };
        }
      } catch (e) {
        log.warn('Failed to parse mods.toml:', e);
      }
    }
    
    // 5. 尝试读取 mcmod.info (旧版 Forge)
    const mcmodEntry = entries.find(e => e.entryName === 'mcmod.info');
    if (mcmodEntry) {
      try {
        const content = zip.readAsText(mcmodEntry);
        const modInfo = safeParseJson(content);
        if (modInfo && Array.isArray(modInfo) && modInfo.length > 0) {
          const mod = modInfo[0];
          return {
            id: mod.modid || '',
            name: mod.name || mod.modid || '',
            version: mod.version || '',
            description: mod.description || '',
            authors: mod.authorList ? mod.authorList.join(', ') : '',
            loader: 'forge'
          };
        }
      } catch (e) {
        log.warn('Failed to parse mcmod.info:', e);
      }
    }
    
    return null;
  } catch (error) {
    log.error('Error reading mod metadata:', error);
    return null;
  }
}

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (result.canceled) return null;
  currentModPath = result.filePaths[0];
  return result.filePaths[0];
});

ipcMain.on('update-mod-path', (event, newPath) => {
  currentModPath = newPath;
});

ipcMain.handle('load-mods', async (event, modPath) => {
  try {
    const files = await fs.promises.readdir(modPath);
    const jarFiles = files.filter(f => f.endsWith('.jar') || f.endsWith('.disabled'));
    
    const mods = jarFiles.map(filename => {
      const isDisabled = filename.endsWith('.disabled');
      let cleanName = filename.replace('.disabled', '');
      cleanName = cleanName.replace(/\.[^.]+$/, '');
      
      const prefixMatch = cleanName.match(/^(\d+)_/);
      const namePrefix = prefixMatch ? prefixMatch[1] : '';
      const displayName = cleanName.replace(/^\d+_/, '');
      
      const filePath = path.join(modPath, filename);
      const metadata = readModMetadata(filePath);
      
      // 从元数据获取信息，如果没有则从文件名提取
      const modId = metadata?.id || '';
      const modName = metadata?.name || displayName;
      const modVersion = metadata?.version || extractVersion(displayName);
      const modDescription = metadata?.description || '';
      const modAuthors = metadata?.authors || '';
      const modLoader = metadata?.loader || '';
      
      // baseName 用于搜索，优先使用元数据中的名称，其次 id，最后从文件名提取
      let baseName = '';
      if (metadata?.name) {
        baseName = metadata.name;
      } else if (metadata?.id) {
        baseName = metadata.id;
      } else {
        // 从文件名提取，但更保守一些
        baseName = displayName.replace(/[\s\-_]*[\d]+\.[\d.]+.*$/, '').trim() || displayName;
      }
      
      return {
        filename,
        name: modName,
        id: modId,
        baseName: baseName,
        version: modVersion,
        description: modDescription,
        authors: modAuthors,
        loader: modLoader,
        isDisabled,
        namePrefix,
        path: filePath
      };
    });
    
    return sortMods(mods);
  } catch (error) {
    log.error('Error loading mods:', error);
    return [];
  }
});

ipcMain.handle('toggle-mod', async (event, modPath, filename) => {
  try {
    const oldPath = path.join(modPath, filename);
    let newFilename;
    
    if (filename.endsWith('.disabled')) {
      newFilename = filename.replace('.disabled', '');
    } else {
      newFilename = filename + '.disabled';
    }
    
    const newPath = path.join(modPath, newFilename);
    await fs.promises.rename(oldPath, newPath);
    
    return { success: true, filename: newFilename };
  } catch (error) {
    log.error('Error toggling mod:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rename-mod', async (event, modPath, oldFilename, newFilename) => {
  try {
    const oldPath = path.join(modPath, oldFilename);
    const newPath = path.join(modPath, newFilename);
    
    if (fs.existsSync(newPath)) {
      return { success: false, error: 'A file with this name already exists' };
    }
    
    await fs.promises.rename(oldPath, newPath);
    return { success: true, filename: newFilename };
  } catch (error) {
    log.error('Error renaming mod:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('reorder-mods', async (event, modPath, orderedFiles) => {
  try {
    const maxLen = getMaxPrefixLength(orderedFiles.length);
    
    const promises = orderedFiles.map((filename, index) => {
      const filePath = path.join(modPath, filename);
      const dir = path.dirname(filePath);
      
      const isDisabled = filename.endsWith('.disabled');
      let cleanName = filename.replace('.disabled', '');
      const actualExt = path.extname(cleanName);
      cleanName = cleanName.replace(/\.[^.]+$/, '');
      
      const nameWithoutPrefix = cleanName.replace(/^\d+_/, '');
      const newPrefix = String(index).padStart(maxLen, '0');
      const newFilename = `${newPrefix}_${nameWithoutPrefix}${actualExt}${isDisabled ? '.disabled' : ''}`;
      
      if (filename !== newFilename) {
        return fs.promises.rename(filePath, path.join(dir, newFilename));
      }
      return Promise.resolve();
    });
    
    await Promise.all(promises);
    return { success: true };
  } catch (error) {
    log.error('Error reordering mods:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('add-prefixes', async (event, modPath, orderedFiles) => {
  try {
    const maxLen = getMaxPrefixLength(orderedFiles.length);
    
    const promises = orderedFiles.map((filename, index) => {
      const filePath = path.join(modPath, filename);
      const dir = path.dirname(filePath);
      
      const isDisabled = filename.endsWith('.disabled');
      let cleanName = filename.replace('.disabled', '');
      const actualExt = path.extname(cleanName);
      cleanName = cleanName.replace(/\.[^.]+$/, '');
      
      if (/^\d+_/.test(cleanName)) {
        return Promise.resolve();
      }
      
      const newPrefix = String(index).padStart(maxLen, '0');
      const newFilename = `${newPrefix}_${cleanName}${actualExt}${isDisabled ? '.disabled' : ''}`;
      
      return fs.promises.rename(filePath, path.join(dir, newFilename));
    });
    
    await Promise.all(promises);
    return { success: true };
  } catch (error) {
    log.error('Error adding prefixes:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('open-mod-link', async (event, type, modName) => {
  const searchName = encodeURIComponent(modName);
  
  if (type === 'mcwiki') {
    const searchUrl = `https://search.mcmod.cn/s?key=${searchName}`;
    await shell.openExternal(searchUrl);
    return { url: searchUrl };
  } else if (type === 'modrinth') {
    const url = `https://modrinth.com/mods?q=${searchName}`;
    await shell.openExternal(url);
    return { url };
  } else if (type === 'curseforge') {
    const url = `https://www.curseforge.com/minecraft/mc-mods/search?search=${searchName}`;
    await shell.openExternal(url);
    return { url };
  }
});

ipcMain.handle('get-mod-links', async (event, modName) => {
  const searchName = encodeURIComponent(modName);
  
  return {
    mcwiki: `https://search.mcmod.cn/s?key=${searchName}`,
    modrinth: `https://modrinth.com/mods?q=${searchName}`,
    curseforge: `https://www.curseforge.com/minecraft/mc-mods/search?search=${searchName}`
  };
});

// 在文件管理器中显示文件
ipcMain.handle('show-file-in-folder', async (event, filePath) => {
  try {
    await shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    log.error('Error showing file in folder:', error);
    return { success: false, error: error.message };
  }
});

// 删除文件
ipcMain.handle('delete-mod', async (event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (error) {
    log.error('Error deleting mod:', error);
    return { success: false, error: error.message };
  }
});
