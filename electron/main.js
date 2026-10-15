const { app, BrowserWindow, shell, Menu, Tray, nativeImage, ipcMain, dialog, globalShortcut, Notification, powerSaveBlocker, session, WebContentsView, BrowserView } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Enable remote debugging port for CDP / Playwright AI agent control
app.commandLine.appendSwitch("remote-debugging-port", "9224");
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

const crashLogPath = path.join(app.getPath("userData"), "crash.log");

process.on("uncaughtException", (err) => {
  try { fs.appendFileSync(crashLogPath, "UNCAUGHT: " + (err?.stack || err) + "\n"); } catch(e){}
});
process.on("unhandledRejection", (reason) => {
  try { fs.appendFileSync(crashLogPath, "REJECTION: " + String(reason) + "\n"); } catch(e){}
});
app.on("before-quit", () => {
  try { fs.appendFileSync(crashLogPath, "app before-quit fired!\n"); } catch(e){}
});

const APP_URL = "https://claude-enterprise-app.vercel.app";
const isDev = process.argv.includes("--dev");
const LOAD_URL = isDev ? "http://localhost:3000" : APP_URL;

let mainWindow = null;
let tray = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Sameer AI Workspace",
    backgroundColor: "#1c1b18",
    frame: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadURL(LOAD_URL);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    try { fs.appendFileSync("C:\\Users\\Master\\sameer workspace\\crash.log", `FAIL_LOAD: ${code} ${desc}\n`); } catch(e){}
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on("resize", () => {
    mainWindow?.webContents.send("openwork:browser:bounds-invalidated");
  });

  // Strip X-Frame-Options and Content-Security-Policy frame-ancestors
  // so the embedded Browser panel loads YouTube, GitHub, Instagram, etc. without a white screen!
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    for (const key of Object.keys(responseHeaders)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'x-frame-options') {
        delete responseHeaders[key];
      }
      if (lowerKey === 'content-security-policy') {
        responseHeaders[key] = responseHeaders[key].map((csp) =>
          csp.replace(/frame-ancestors[^;]+;?/gi, '')
        );
      }
    }
    callback({ responseHeaders });
  });

  // OpenWork Native Browser Control (Embedded WebContentsView / BrowserView)
  let browserViewInstance = null;
  let currentBrowserUrl = "https://github.com";

  function getOrCreateBrowserView() {
    if (browserViewInstance && !browserViewInstance.webContents.isDestroyed()) {
      return browserViewInstance;
    }

    const viewOptions = {
      webPreferences: {
        partition: "persist:sameer-browser",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    };

    if (typeof WebContentsView !== "undefined") {
      browserViewInstance = new WebContentsView(viewOptions);
    } else {
      browserViewInstance = new BrowserView(viewOptions);
    }

    const contents = browserViewInstance.webContents;

    contents.on("did-navigate", (_event, url) => {
      currentBrowserUrl = url;
      mainWindow?.webContents.send("openwork:browser:navigated", {
        url,
        title: contents.getTitle(),
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      });
    });

    contents.on("did-navigate-in-page", (_event, url) => {
      currentBrowserUrl = url;
      mainWindow?.webContents.send("openwork:browser:navigated", {
        url,
        title: contents.getTitle(),
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      });
    });

    contents.on("page-title-updated", (_event, title) => {
      mainWindow?.webContents.send("openwork:browser:title", {
        title,
        url: contents.getURL(),
      });
    });

    contents.loadURL(currentBrowserUrl);
    return browserViewInstance;
  }

  function attachBrowserView(bounds) {
    if (!mainWindow || mainWindow.isDestroyed() || !bounds) return false;
    const view = getOrCreateBrowserView();

    const zoomFactor = mainWindow.webContents.getZoomFactor() || 1;
    const x = Math.round(bounds.x * zoomFactor);
    const y = Math.round(bounds.y * zoomFactor);
    const width = Math.round(bounds.width * zoomFactor);
    const height = Math.round(bounds.height * zoomFactor);

    if (typeof WebContentsView !== "undefined" && mainWindow.contentView) {
      if (!mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.addChildView(view);
      }
      view.setBounds({ x, y, width, height });
      view.setVisible(true);
    } else if (mainWindow.setBrowserView) {
      mainWindow.setBrowserView(view);
      view.setBounds({ x, y, width, height });
      view.setAutoResize({ width: true, height: true });
    }

    return true;
  }

  function hideBrowserView() {
    if (!mainWindow || mainWindow.isDestroyed() || !browserViewInstance) return false;
    if (typeof WebContentsView !== "undefined" && mainWindow.contentView) {
      browserViewInstance.setVisible(false);
      if (mainWindow.contentView.children.includes(browserViewInstance)) {
        mainWindow.contentView.removeChildView(browserViewInstance);
      }
    } else if (mainWindow.removeBrowserView) {
      mainWindow.removeBrowserView(browserViewInstance);
    }
    return true;
  }

  function setBrowserBounds(bounds) {
    if (!mainWindow || mainWindow.isDestroyed() || !browserViewInstance || !bounds) return false;
    const zoomFactor = mainWindow.webContents.getZoomFactor() || 1;
    const x = Math.round(bounds.x * zoomFactor);
    const y = Math.round(bounds.y * zoomFactor);
    const width = Math.round(bounds.width * zoomFactor);
    const height = Math.round(bounds.height * zoomFactor);
    browserViewInstance.setBounds({ x, y, width, height });
    return true;
  }

  // Register OpenWork IPC Handlers
  ipcMain.removeHandler("openwork:browser:show");
  ipcMain.handle("openwork:browser:show", (_event, bounds) => {
    return attachBrowserView(bounds);
  });

  ipcMain.removeHandler("openwork:browser:hide");
  ipcMain.handle("openwork:browser:hide", () => {
    return hideBrowserView();
  });

  ipcMain.removeHandler("openwork:browser:bounds");
  ipcMain.handle("openwork:browser:bounds", (_event, bounds) => {
    return setBrowserBounds(bounds);
  });

  ipcMain.removeHandler("openwork:browser:navigate");
  ipcMain.handle("openwork:browser:navigate", (_event, url) => {
    const view = getOrCreateBrowserView();
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    currentBrowserUrl = target;
    view.webContents.loadURL(target);
    return { success: true, url: target };
  });

  ipcMain.removeHandler("openwork:browser:back");
  ipcMain.handle("openwork:browser:back", () => {
    if (browserViewInstance && !browserViewInstance.webContents.isDestroyed()) {
      if (browserViewInstance.webContents.canGoBack()) {
        browserViewInstance.webContents.goBack();
      }
    }
    return true;
  });

  ipcMain.removeHandler("openwork:browser:forward");
  ipcMain.handle("openwork:browser:forward", () => {
    if (browserViewInstance && !browserViewInstance.webContents.isDestroyed()) {
      if (browserViewInstance.webContents.canGoForward()) {
        browserViewInstance.webContents.goForward();
      }
    }
    return true;
  });

  ipcMain.removeHandler("openwork:browser:reload");
  ipcMain.handle("openwork:browser:reload", () => {
    if (browserViewInstance && !browserViewInstance.webContents.isDestroyed()) {
      browserViewInstance.webContents.reload();
    }
    return true;
  });

  ipcMain.removeHandler("openwork:browser:state");
  ipcMain.handle("openwork:browser:state", () => {
    if (!browserViewInstance || browserViewInstance.webContents.isDestroyed()) {
      return { isAttached: false, url: currentBrowserUrl, title: "" };
    }
    const contents = browserViewInstance.webContents;
    return {
      isAttached: true,
      url: contents.getURL() || currentBrowserUrl,
      title: contents.getTitle(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
      isLoading: contents.isLoading(),
    };
  });

  // Open external links in real browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const appOrigin = new URL(APP_URL).origin;
      const localhostAllowed = isDev && target.origin === "http://localhost:3000";
      if (target.origin === appOrigin || localhostAllowed) {
        return { action: "allow" };
      }
      if (target.protocol === "https:" || target.protocol === "http:") {
        shell.openExternal(target.toString());
      }
      return { action: "deny" };
    } catch {
      return { action: "deny" };
    }
  });

  mainWindow.on("close", (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// System Tray
function createTray() {
  try {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    tray.setToolTip("Sameer AI Workspace");
    const menu = Menu.buildFromTemplate([
      { label: "Open Sameer AI Workspace", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: "New Chat", click: () => { mainWindow?.show(); mainWindow?.webContents.executeJavaScript("window.__newChat && window.__newChat()"); } },
      { type: "separator" },
      { label: "Quit", click: () => { tray = null; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch (e) { /* icon not found — skip tray */ }
}

// File System IPC
ipcMain.handle("open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Text & Code Files", extensions: ["txt","md","js","ts","tsx","jsx","py","json","html","css","xml","yaml","yml","csv","sh","bat","env","toml","ini","sql","rs","go","cpp","c","h","php","rb","swift","kt","dart","vue","svelte"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return { path: filePath, name: path.basename(filePath), content };
  } catch (e) { return null; }
});

ipcMain.handle("save-file", async (event, { filePath, content }) => {
  try {
    if (!filePath) {
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: "untitled.txt" });
      if (result.canceled) return null;
      filePath = result.filePath;
    }
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  } catch (e) { return null; }
});

ipcMain.handle("new-file", async () => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: "untitled.txt" });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, "", "utf-8");
  return { path: result.filePath, name: path.basename(result.filePath), content: "" };
});

ipcMain.handle("get-version", () => app.getVersion());

let blockerId = null;
ipcMain.handle("start-automation", () => {
  if (blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
  }
  return true;
});

ipcMain.handle("stop-automation", () => {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  return false;
});

ipcMain.handle("show-notification", (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

// Native code execution for desktop Code Runner.
ipcMain.handle("execute-code", async (event, { code, language = "python" }) => {
  if (typeof code !== "string" || !code.trim()) {
    return { success: false, stdout: "", stderr: "No code supplied.", exitCode: 1, executionTimeMs: 0 };
  }
  const startTime = Date.now();
  const safeLanguage = String(language || "python").toLowerCase();
  const randId = Math.random().toString(36).slice(2, 10);
  const tempDir = app.getPath("temp");
  let tempFilePath = null;
  let cmd = "";

  try {
    if (safeLanguage === "python" || safeLanguage === "py") {
      tempFilePath = path.join(tempDir, "sameer_runner_" + randId + ".py");
      fs.writeFileSync(tempFilePath, code, "utf8");
      cmd = `python "${tempFilePath}"`;
    } else if (safeLanguage === "javascript" || safeLanguage === "js" || safeLanguage === "node") {
      tempFilePath = path.join(tempDir, "sameer_runner_" + randId + ".js");
      fs.writeFileSync(tempFilePath, code, "utf8");
      cmd = `node "${tempFilePath}"`;
    } else if (safeLanguage === "powershell" || safeLanguage === "ps1") {
      tempFilePath = path.join(tempDir, "sameer_runner_" + randId + ".ps1");
      fs.writeFileSync(tempFilePath, code, "utf8");
      cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFilePath}"`;
    } else if (safeLanguage === "cmd" || safeLanguage === "bash" || safeLanguage === "sh") {
      cmd = code;
    } else {
      return { success: false, stdout: "", stderr: "Unsupported language for native execution: " + safeLanguage, exitCode: 1, executionTimeMs: Date.now() - startTime };
    }

    const workspaceDir = path.join(os.homedir(), "sameer workspace");
    const nodeModulesDir = path.join(workspaceDir, "node_modules");
    const nodePath = process.env.NODE_PATH ? `${process.env.NODE_PATH};${nodeModulesDir}` : nodeModulesDir;

    const result = await new Promise((resolve) => {
      const { exec } = require("child_process");
      exec(cmd, {
        cwd: workspaceDir,
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: false,
        env: { ...process.env, PYTHONUNBUFFERED: "1", NODE_PATH: nodePath }
      }, (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout || "",
          stderr: stderr || (error?.message || ""),
          exitCode: error?.code || 0,
          executionTimeMs: Date.now() - startTime,
          error: error?.message
        });
      });
    });
    return result;
  } finally {
    if (tempFilePath) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  }
});

// Launch Real External Chrome Browser
ipcMain.handle("launch-external-browser", async () => {
  try {
    const { spawn } = require("child_process");
    const browserDir = path.join(os.homedir(), "sameer workspace", "browser");
    const script = path.join(browserDir, "browser_start.mjs");
    const child = spawn("node", [script], {
      cwd: browserDir,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

// Automatic Native In-App Updater & Restart
ipcMain.handle("restart-to-update", async (event, { downloadUrl } = {}) => {
  try {
    const https = require("https");
    const { spawn } = require("child_process");
    const targetUrl = downloadUrl || "https://github.com/sameer-sys/claude-enterprise-desktop-app/releases/latest/download/Sameer.AI.Workspace.Setup.1.0.0.exe";
    const tempExe = path.join(app.getPath("temp"), `Sameer-AI-Workspace-Update-${Date.now()}.exe`);
    
    const fileStream = fs.createWriteStream(tempExe);
    
    const download = (url) => new Promise((resolve, reject) => {
      https.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return download(response.headers.location).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        }
        response.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve(tempExe);
        });
      }).on("error", (err) => {
        try { fs.unlinkSync(tempExe); } catch (e) {}
        reject(err);
      });
    });

    await download(targetUrl);

    // Launch installer and cleanly exit current process
    const child = spawn(tempExe, [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    app.quit();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

// App menu
function buildMenu() {
  const template = [
    { label: "Sameer AI Workspace", submenu: [
      { label: "About", role: "about" },
      { type: "separator" },
      { label: "Check for Updates...", click: () => shell.openExternal(APP_URL) },
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => { tray = null; app.quit(); } },
    ]},
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "selectAll" },
    ]},
    { label: "View", submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.reload() },
      { label: "Hard Reload", accelerator: "CmdOrCtrl+Shift+R", click: () => mainWindow?.webContents.reloadIgnoringCache() },
      { type: "separator" },
      { role: "togglefullscreen" },
      { label: "Dev Tools", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
      { type: "separator" },
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", role: "zoomIn" },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
      { label: "Reset Zoom", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
    ]},
    { label: "Window", submenu: [
      { role: "minimize" },
      { label: "Hide to Tray", click: () => mainWindow?.hide() },
      { type: "separator" },
      { label: "Bring All to Front", role: "front" },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  createTray();

  // Global shortcut: Ctrl+Shift+Space to show/hide
  globalShortcut.register("CmdOrCtrl+Shift+Space", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else { mainWindow?.show(); mainWindow?.focus(); }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !tray) app.quit();
});

app.setName("Sameer AI Workspace");
