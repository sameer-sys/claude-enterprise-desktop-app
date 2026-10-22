const { contextBridge, ipcRenderer } = require('electron');

// Expose native desktop APIs to the web app
// The web app can check window.electronAPI to know it is running inside Electron
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // File System (for Cowork mode — native dialogs instead of browser File Access API)
  openFile: () => ipcRenderer.invoke('open-file'),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', { filePath, content }),
  newFile: () => ipcRenderer.invoke('new-file'),
  executeCode: (code, language) => ipcRenderer.invoke('execute-code', { code, language }),

  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Continuous Automation — Prevent Sleep / Suspension
  startAutomation: () => ipcRenderer.invoke('start-automation'),
  stopAutomation: () => ipcRenderer.invoke('stop-automation'),

  // Native In-App Auto-Update & Restart
  restartToUpdate: (downloadUrl) => ipcRenderer.invoke('restart-to-update', { downloadUrl }),

  // Launch Real External Chrome Browser
  launchExternalBrowser: () => ipcRenderer.invoke('launch-external-browser'),

  // OpenWork Native Browser Control
  browser: {
    show: (bounds, sessionId) => ipcRenderer.invoke('openwork:browser:show', bounds, sessionId),
    hide: (options) => ipcRenderer.invoke('openwork:browser:hide', options),
    navigate: (url) => ipcRenderer.invoke('openwork:browser:navigate', url),
    openUrl: (url) => ipcRenderer.invoke('openwork:browser:openUrl', url),
    back: () => ipcRenderer.invoke('openwork:browser:back'),
    forward: () => ipcRenderer.invoke('openwork:browser:forward'),
    reload: () => ipcRenderer.invoke('openwork:browser:reload'),
    bounds: (bounds) => ipcRenderer.invoke('openwork:browser:bounds', bounds),
    getState: () => ipcRenderer.invoke('openwork:browser:state'),
    observe: () => ipcRenderer.invoke('openwork:browser:observe'),
    click: (params) => ipcRenderer.invoke('openwork:browser:click', params),
    type: (params) => ipcRenderer.invoke('openwork:browser:type', params),
    screenshot: () => ipcRenderer.invoke('openwork:browser:screenshot'),
    createTab: (url, sessionId) => ipcRenderer.invoke('openwork:browser:createTab', url, sessionId),
    closeTab: (tabId) => ipcRenderer.invoke('openwork:browser:closeTab', tabId),
    selectTab: (tabId) => ipcRenderer.invoke('openwork:browser:selectTab', tabId),
    onNavigated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('openwork:browser:navigated', handler);
      return () => ipcRenderer.removeListener('openwork:browser:navigated', handler);
    },
    onTitleUpdated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('openwork:browser:title', handler);
      return () => ipcRenderer.removeListener('openwork:browser:title', handler);
    },
    onBoundsInvalidated: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('openwork:browser:bounds-invalidated', handler);
      return () => ipcRenderer.removeListener('openwork:browser:bounds-invalidated', handler);
    },
    onOpenPanel: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('openwork:browser:open-panel', handler);
      return () => ipcRenderer.removeListener('openwork:browser:open-panel', handler);
    },
  },

  // Approvals System
  approvals: {
    respond: (id, approved) => ipcRenderer.invoke('openwork:approval:respond', { id, approved }),
    list: () => ipcRenderer.invoke('openwork:approval:list'),
    onRequested: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('openwork:approval:requested', handler);
      return () => ipcRenderer.removeListener('openwork:approval:requested', handler);
    },
  },

  // Terminal & Process System
  terminal: {
    spawn: (id, shell) => ipcRenderer.invoke('openwork:terminal:spawn', { id, shell }),
    write: (id, input) => ipcRenderer.invoke('openwork:terminal:write', { id, input }),
    read: (id, clear) => ipcRenderer.invoke('openwork:terminal:read', { id, clear }),
    kill: (id) => ipcRenderer.invoke('openwork:terminal:kill', { id }),
  },

  // Embedded Database System (SQLite / Disk)
  database: {
    getSessions: () => ipcRenderer.invoke('openwork:db:get-sessions'),
    saveSession: (session) => ipcRenderer.invoke('openwork:db:save-session', session),
    deleteSession: (id) => ipcRenderer.invoke('openwork:db:delete-session', id),
    getGroups: () => ipcRenderer.invoke('openwork:db:get-groups'),
    saveGroup: (group) => ipcRenderer.invoke('openwork:db:save-group', group),
  },

  // OpenWork Local Tool Execution Bridge (Browser, Shell, Filesystem, Claude Desktop)
  executeLocalTool: (name, args) => ipcRenderer.invoke('openwork:local:execute-tool', { name, args }),
  getLocalTools: () => ipcRenderer.invoke('openwork:local:get-tools'),

  // Claude Desktop Local MCP (tools from %APPDATA%\Claude\claude_desktop_config.json)
  claudeDesktopMcp: {
    listTools: () => ipcRenderer.invoke('openwork:mcp:list-claude-desktop'),
    callTool: (serverName, toolName, args) => ipcRenderer.invoke('openwork:mcp:call-claude-desktop', { serverName, toolName, args }),
  },
});
