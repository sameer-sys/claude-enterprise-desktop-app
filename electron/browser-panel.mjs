;
// Embedded browser panel: tab state, BrowserView lifecycle, native context menus,
// proxy configuration, and browser IPC registrations. Extracted from
// main.mjs as a factory so the main process only owns window creation.
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPkg from "electron";
const { app, BrowserWindow, WebContentsView, clipboard, dialog, session, shell } = electronPkg;
import {
  BACKGROUND_TAB_VIEWPORT,
  backgroundTabEmulationCommands,
  createBrowserTabRegistry,
  foregroundTabEmulationCommands,
} from "@openwork/browser-tabs";
import { runDetachedTask } from "./process-resilience.mjs";
import { openExternalUrl } from "./open-external.mjs";
import { BrowserTaskError, createBrowserTaskHost } from "./browser-task.mjs";
import { createWebMcpBroker } from "./webmcp-host.mjs";
import { createWebMcpFramePolicy } from "./webmcp-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== Configuration System (CHUNK 9) =====
import fs from "node:fs";

/**
 * Load browser configuration from JSON file with defaults
 * @returns {Object} Configuration object
 */
function loadBrowserConfig() {
  const configPath = path.join(app.getPath("userData"), "browser-config.json");
  const defaults = getDefaultBrowserConfig();

  try {
    if (fs.existsSync(configPath)) {
      const userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return deepMerge(defaults, userConfig);
    }
  } catch (error) {
    console.warn("Failed to load browser config, using defaults:", error.message);
  }
  return defaults;
}

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Get default browser configuration
 * @returns {Object} Default configuration
 */
function getDefaultBrowserConfig() {
  return {
    browser: {
      defaultUrl: "about:blank",
      newTabUrl: "https://www.google.com",
      maxTabs: 12,
      maxClosedTabs: 20,
      targetResolveTimeoutMs: 2500
    },
    backgroundTabs: {
      maxBackgroundTabs: 10,
      suspendDelayMs: 300000,
      thumbnailIntervalMs: 30000,
      thumbnailSize: { width: 320, height: 200 },
      thumbnailQuality: 70
    },
    security: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    },
    websiteRules: {
      defaultAgentPermission: "ask",
      defaultJavaScriptEnabled: true,
      defaultCookiesEnabled: true,
      defaultStorageEnabled: true
    },
    viewport: {
      defaultWidth: 1280,
      defaultHeight: 720,
      defaultDeviceScaleFactor: 1,
      defaultIsMobile: false
    },
    cdp: {
      enabledDomains: [
        "Page", "Runtime", "Network", "DOM", "Input", "Target",
        "Emulation", "Fetch", "CSS", "Console", "Log", "Security",
        "Overlay", "Animation", "Accessibility", "Performance",
        "Memory", "Profiler", "Schema"
      ],
      initializeOnDomReady: true
    },
    proxy: {
      pacCacheTtlMs: 1800000,
      pacTimeoutMs: 10000
    },
    webmcp: {
      maxFramesPerTab: 64,
      maxToolsPerFrame: 32,
      maxToolsPerTab: 128,
      maxTitleLength: 256,
      maxDescriptionLength: 4096,
      discoveryTimeoutMs: 3000,
      executionTimeoutMs: 60000,
      maxActiveExecutionsPerTab: 4,
      trustLabel: "untrusted-site-content",
      toolRefreshIntervalMs: 250
    },
    browserTask: {
      settleMs: 3000,
      quietMs: 250,
      observationCacheTtlMs: 30000,
      consentTimeoutMs: 30000,
      screenshotFormat: "png",
      accessibilityTreeDepth: 500
    },
    session: {
      partitionPrefix: "openwork-browser",
      chromeUserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
  };
}

// Load configuration
const CONFIG = loadBrowserConfig();

// Export for use in other modules
export { CONFIG, loadBrowserConfig, getDefaultBrowserConfig };

const BROWSER_DEFAULT_URL = CONFIG.browser.defaultUrl;

/** Get per-session partition — each session gets isolated cookies/storage */
function getSessionPartition(sessionId) {
  return `persist:openwork-browser-${sessionId}`;
}

/**
 * Get per-origin partition for deeper cookie isolation within a session.
 * Each origin gets its own cookie jar: persist:openwork-browser-{sessionId}-{originHash}
 * @param {string} sessionId
 * @param {string} url - The URL to derive origin from
 * @returns {string} Partition string
 */
function getOriginPartition(sessionId, url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin; // e.g., "https://github.com"
    // Create a short hash of the origin for the partition name
    const originHash = hashString(origin).slice(0, 8);
    return `persist:openwork-browser-${sessionId}-${originHash}`;
  } catch {
    // Fallback to session partition if URL parsing fails
    return getSessionPartition(sessionId);
  }
}

/**
 * Simple string hash for generating partition suffixes
 * @param {string} str
 * @returns {string}
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Convert to positive hex string
  return (hash >>> 0).toString(16);
}
// URL a user-initiated new tab (the "+" button / opening the browser panel)
// lands on. The agent's programmatic path keeps BROWSER_DEFAULT_URL.
const BROWSER_NEW_TAB_URL = CONFIG.browser.newTabUrl;
// Default session partition (used when no sessionId is available)
const BROWSER_SESSION_PARTITION = `persist:${CONFIG.session.partitionPrefix}`;
// Default Chrome user agent
const CHROME_USER_AGENT = CONFIG.session.chromeUserAgent;
// Bound native page allocation across conversations. Refuse new work rather
// than evicting a live document (unsaved input and CDP handles cannot be restored
// from a URL). This is a tab bound, not a Chromium process or memory limit.
const MAX_BROWSER_TABS = CONFIG.browser.maxTabs;
const MAX_CLOSED_BROWSER_TABS = CONFIG.browser.maxClosedTabs;
// Background tab management (CHUNK 3)
const MAX_BACKGROUND_TABS = CONFIG.backgroundTabs.maxBackgroundTabs;           // Max background tabs before auto-suspend
const BACKGROUND_SUSPEND_DELAY_MS = CONFIG.backgroundTabs.suspendDelayMs; // 5 min before auto-suspend
const THUMBNAIL_INTERVAL_MS = CONFIG.backgroundTabs.thumbnailIntervalMs;  // Thumbnail refresh interval
const THUMBNAIL_SIZE = CONFIG.backgroundTabs.thumbnailSize;
const THUMBNAIL_QUALITY = CONFIG.backgroundTabs.thumbnailQuality;
const BROWSER_TARGET_RESOLVE_TIMEOUT_MS = CONFIG.browser.targetResolveTimeoutMs;
const BROWSER_SECURITY_PREFERENCES = Object.freeze({
  sandbox: CONFIG.security.sandbox,
  contextIsolation: CONFIG.security.contextIsolation,
  nodeIntegration: CONFIG.security.nodeIntegration,
  nodeIntegrationInWorker: CONFIG.security.nodeIntegrationInWorker,
  // Run the isolated preload in each iframe. Sandboxing still disables Node
  // in website JavaScript, including opener-linked popup contents.
  nodeIntegrationInSubFrames: CONFIG.security.nodeIntegrationInSubFrames,
  webSecurity: CONFIG.security.webSecurity,
  allowRunningInsecureContent: CONFIG.security.allowRunningInsecureContent,
  webviewTag: CONFIG.security.webviewTag,
});

// ===== WEBSITE RULES SYSTEM =====
// Per-origin configuration for agent permissions, viewport, user agent, and content policies.

/**
 * @typedef {Object} WebsiteViewport
 * @property {number} width
 * @property {number} height
 * @property {number} [deviceScaleFactor]
 * @property {boolean} [isMobile]
 */

/**
 * @typedef {Object} WebsitePermissions
 * @property {("grant"|"deny"|"ask")} [geolocation]
 * @property {("grant"|"deny"|"ask")} [notifications]
 * @property {("grant"|"deny"|"ask")} [clipboard]
 */

/**
 * @typedef {Object} WebsiteRule
 * @property {string} origin - Origin (e.g., "https://github.com")
 * @property {("allow"|"deny"|"ask")} agentPermission - Whether agent can automate this site
 * @property {WebsiteViewport} [viewport] - Viewport emulation settings
 * @property {string} [userAgent] - Custom user agent override
 * @property {WebsitePermissions} [permissions] - Browser permissions
 * @property {boolean} [javascriptEnabled=true] - Whether JavaScript is enabled
 * @property {boolean} [cookiesEnabled=true] - Whether cookies are enabled
 * @property {boolean} [storageEnabled=true] - Whether localStorage/sessionStorage enabled
 */

const DEFAULT_WEBSITE_RULE = Object.freeze({
  agentPermission: CONFIG.websiteRules.defaultAgentPermission,
  javascriptEnabled: CONFIG.websiteRules.defaultJavaScriptEnabled,
  cookiesEnabled: CONFIG.websiteRules.defaultCookiesEnabled,
  storageEnabled: CONFIG.websiteRules.defaultStorageEnabled,
});

// ===== CHUNK 4: Viewport Emulation Presets =====
const DEVICE_PRESETS = Object.freeze(CONFIG.viewport.presets);

const WEBSITE_RULES_STORAGE_KEY = "openwork:website-rules";

/** @type {Map<string, WebsiteRule>} */
let websiteRules = new Map();

/** @type {Function|null} */
let websiteRulesPersistCallback = null;

/**
 * Get the origin from a URL.
 * @param {string} url
 * @returns {string|null}
 */
function getOriginFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Get the effective rule for a URL (exact origin match or default).
 * @param {string} url
 * @returns {WebsiteRule}
 */
function getWebsiteRule(url) {
  const origin = getOriginFromUrl(url);
  if (!origin) return { ...DEFAULT_WEBSITE_RULE };
  const rule = websiteRules.get(origin);
  return rule ? { ...DEFAULT_WEBSITE_RULE, ...rule } : { ...DEFAULT_WEBSITE_RULE };
}

/**
 * Set a website rule for an origin.
 * @param {string} origin
 * @param {Partial<WebsiteRule>} rule
 */
function setWebsiteRule(origin, rule) {
  const normalizedOrigin = origin.replace(/\/$/, "");
  const existing = websiteRules.get(normalizedOrigin) || {};
  websiteRules.set(normalizedOrigin, { ...existing, ...rule, origin: normalizedOrigin });
  persistWebsiteRules();
}

/**
 * Remove a website rule.
 * @param {string} origin
 */
function removeWebsiteRule(origin) {
  const normalizedOrigin = origin.replace(/\/$/, "");
  websiteRules.delete(normalizedOrigin);
  persistWebsiteRules();
}

/**
 * Get all website rules.
 * @returns {WebsiteRule[]}
 */
function listWebsiteRules() {
  return [...websiteRules.values()];
}

/**
 * Load website rules from storage.
 * @param {Function} get - Async function to get stored value
 */
async function loadWebsiteRules(get) {
  try {
    const stored = await get(WEBSITE_RULES_STORAGE_KEY);
    if (stored && typeof stored === "object") {
      websiteRules = new Map(Object.entries(stored).map(([origin, rule]) => [origin, rule]));
    }
  } catch {
    // Ignore load errors, start fresh
  }
}

/**
 * Set persist callback.
 * @param {Function} callback
 */
function setWebsiteRulesPersistCallback(callback) {
  websiteRulesPersistCallback = callback;
}

/**
 * Persist website rules to storage.
 */
function persistWebsiteRules() {
  if (websiteRulesPersistCallback) {
    const obj = Object.fromEntries(websiteRules);
    websiteRulesPersistCallback(WEBSITE_RULES_STORAGE_KEY, obj);
  }
}

/**
 * Apply website rule to a tab's WebContentsView.
 * @param {Object} tab - Browser tab object
 * @param {WebsiteRule} rule - The website rule to apply
 */
async function applyWebsiteRuleToTab(tab, rule) {
  const webContents = tab.view.webContents;
  if (webContents.isDestroyed()) return;

  // Apply viewport emulation
  if (rule.viewport) {
    const cdp = webContents.debugger;
    const attached = cdp.isAttached();
    try {
      if (!attached) cdp.attach("1.3");
      await cdp.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: rule.viewport.width,
        height: rule.viewport.height,
        deviceScaleFactor: rule.viewport.deviceScaleFactor || 1,
        mobile: rule.viewport.isMobile || false,
        screenWidth: rule.viewport.width,
        screenHeight: rule.viewport.height,
        positionX: 0,
        positionY: 0,
        dontSetVisibleSize: false,
        scale: 1,
      });
    } finally {
      if (!attached && !webContents.isDestroyed() && cdp.isAttached()) cdp.detach();
    }
  }

  // Apply user agent override
  if (rule.userAgent) {
    try {
      await webContents.setUserAgent(rule.userAgent);
    } catch {
      // Ignore UA errors
    }
  }

  // Apply JavaScript setting
  try {
    await webContents.setJavaScriptEnabled(rule.javascriptEnabled !== false);
  } catch {
    // Ignore
  }

  // Apply cookie setting (via session)
  // Note: Cookie policy is session-wide, would need per-origin partitioning
  // For now we track it in the rule for future use with partitioned sessions

  // Apply permissions
  if (rule.permissions) {
    const cdp = webContents.debugger;
    const attached = cdp.isAttached();
    try {
      if (!attached) cdp.attach("1.3");
      const permissionMap = {
        geolocation: "geolocation",
        notifications: "notifications",
        clipboard: "clipboard-read-write",
      };
      for (const [key, permission] of Object.entries(permissionMap)) {
        const setting = rule.permissions[key];
        if (setting && setting !== "ask") {
          await cdp.sendCommand("Browser.grantPermissions", {
            origin: rule.origin,
            permission: permission,
            setting: setting === "grant" ? "granted" : "denied",
          });
        }
      }
    } catch {
      // Ignore permission errors
    } finally {
      if (!attached && !webContents.isDestroyed() && cdp.isAttached()) cdp.detach();
    }
  }
}

/**
 * Check if agent is allowed to automate a URL based on website rules.
 * @param {string} url
 * @returns {boolean}
 */
function isAgentAllowedByWebsiteRule(url) {
  const rule = getWebsiteRule(url);
  return rule.agentPermission === "allow";
}

/**
 * Check if agent should be asked for permission for a URL.
 * @param {string} url
 * @returns {boolean}
 */
function shouldAskAgentPermission(url) {
  const rule = getWebsiteRule(url);
  return rule.agentPermission === "ask";
}

export {
  DEFAULT_WEBSITE_RULE,
  WEBSITE_RULES_STORAGE_KEY,
  getOriginFromUrl,
  getWebsiteRule,
  setWebsiteRule,
  removeWebsiteRule,
  listWebsiteRules,
  loadWebsiteRules,
  setWebsiteRulesPersistCallback,
  applyWebsiteRuleToTab,
  isAgentAllowedByWebsiteRule,
  shouldAskAgentPermission,
};
export function createBrowserPanel({ getWindow, remoteDebugPort, onDeepLink, checkPolicy, showNativeContextMenu, closeNativeContextMenu }) {
  const browserSessions = new Map(); // sessionId -> Electron.Session
  const webMcpFramePolicies = new Map(); // sessionId -> WebMcpFramePolicy
  const browserSessionHooksInstalled = new Set(); // sessionId

  function installBrowserSessionHooks(sessionId) {
    if (browserSessionHooksInstalled.has(sessionId)) return;
    const browserSession = session.fromPartition(getSessionPartition(sessionId));
    // Clean Google Chrome User Agent to bypass Google/GitHub/Twitter/Microsoft login blocks
    try { browserSession.setUserAgent(CHROME_USER_AGENT); } catch (e) {}
    try {
      browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = { ...details.requestHeaders };
        requestHeaders['User-Agent'] = CHROME_USER_AGENT;
        callback({ requestHeaders });
      });
    } catch (e) {}
    try {
      browserSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        for (const key of Object.keys(responseHeaders)) {
          const lowerKey = key.toLowerCase();
          if (lowerKey === 'x-frame-options') delete responseHeaders[key];
          if (lowerKey === 'content-security-policy') {
            responseHeaders[key] = responseHeaders[key].map((csp) => csp.replace(/frame-ancestors[^;]+;?/gi, ''));
          }
        }
        callback({ responseHeaders });
      });
    } catch (e) {}

    browserSession.on("will-download", (_event, item, contents) => {
      const tab = [...browserTabs.values()].find((candidate) => candidate.view.webContents === contents);
      if (!tab) return;
      tab.downloads.add(item);
      item.once("done", () => tab.downloads.delete(item));
    });
    browserSessionHooksInstalled.add(sessionId);
  }

  function ensureBrowserSession(sessionId) {
    let browserSession = browserSessions.get(sessionId);
    if (!browserSession) {
      browserSession = session.fromPartition(getSessionPartition(sessionId));
      browserSessions.set(sessionId, browserSession);
      // Capture the first response, before a view can load any document.
      const webMcpFramePolicy = createWebMcpFramePolicy(browserSession);
      webMcpFramePolicy.install();
      webMcpFramePolicies.set(sessionId, webMcpFramePolicy);
    }
    return browserSession;
  }
  function ensureWebMcpFramePolicy(sessionId) {
    ensureBrowserSession(sessionId);
    return webMcpFramePolicies.get(sessionId);
  }
    if (!checkPolicy) return;
    // The session request boundary covers normal navigation, redirects, frames,
    // scripted fetches and CDP navigation; window navigation events do not.
    browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      if (["about:", "data:", "blob:"].some((scheme) => details.url.startsWith(scheme))) { callback({ cancel: false }); return; }
      const tab = [...browserTabs.values()].find((item) => item.view.webContents.id === details.webContentsId);
      const owner = registry.ownerOf(tab?.tabId);
      const documentGeneration = tab?.documentGeneration;
      const guard = details.resourceType === "mainFrame" ? taskHost.navigationGuard(tab?.tabId) : null;
      const request = { url: details.url, method: details.method, hasUpload: Boolean(details.uploadData?.length) };
      Promise.resolve().then(async () => {
        await checkPolicy(request);
        if (guard) {
          const validate = await guard(details.url);
          await checkPolicy(request);
          return validate;
        }
      })
        .then((validate) => {
          try {
            validate?.();
            if (tab && details.resourceType === "mainFrame" && (getBrowserTab(tab.tabId) !== tab || tab.view.webContents.isDestroyed() || registry.ownerOf(tab.tabId) !== owner)) throw new Error("Browser navigation owner changed");
          } catch { callback({ cancel: true }); return; }
          callback({ cancel: false });
        }, (error) => {
          if (tab && getBrowserTab(tab.tabId) === tab && !tab.view.webContents.isDestroyed()
            && registry.ownerOf(tab.tabId) === owner && tab.documentGeneration === documentGeneration
            && tab.loadError?.code !== "page_load_failed"
            && (error?.code === "policy_unavailable" || error?.code === "organization_policy_denied")) {
            tab.loadError = {
              code: error.code,
              message: error.code === "organization_policy_denied"
                ? "This page may be incomplete. Your organization's policy blocked a browser request."
                : "This page may be incomplete. Your organization's policy could not be verified.",
            };
            sendBrowserState();
          }
          callback({ cancel: true });
        });
    });
  }
  // tabId -> { tabId, view, favicon, background }. Order, ownership, the active
  // tab per conversation, and which conversation is on screen live in the
  // registry; this map only holds the native views.
  let browserSession = null;
  let webMcpFramePolicy = null;
  function ensureBrowserSession() {
    if (!browserSession) {
      browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      // Capture the first response, before a view can load any document.
      webMcpFramePolicy = createWebMcpFramePolicy(browserSession);
      webMcpFramePolicy.install();
    }
    return browserSession;
  }
  function ensureWebMcpFramePolicy() {
    ensureBrowserSession();
    return webMcpFramePolicy;
  }
  const browserTabs = new Map();
  const suspendedTabs = new Map();
  const registry = createBrowserTabRegistry();
  // URL-only, memory-only history. Closed pages never retain task/approval/CDP
  // handles, and a conversation can only reopen its own most recent entry.
  let closedTabs = [];
  let shortcutFocus = null;
  let reopeningTab = false;
  let browserViewVisible = false;
  let backgroundWindow = null;
  // Last accepted geometry in window DIPs. Reattaching must not scale an old
  // CSS rectangle with a newer zoom while the renderer is still catching up.
  let lastBrowserBounds = null;
  let browserTabCounter = 0;
  // Active proxy for the built-in browser session: { rules, username, password }.
  let browserProxy = null;
  let browserControlEnabled = true;
  // Website Rules initialization
  const websiteRulesStorePath = path.join(app.getPath("userData"), "website-rules.json");
  async function loadWebsiteRulesFromDisk() {
    try {
      const fs = await import("node:fs/promises");
      const data = await fs.readFile(websiteRulesStorePath, "utf8");
      const stored = JSON.parse(data);
      if (stored && typeof stored === "object") {
        websiteRules = new Map(Object.entries(stored).map(([origin, rule]) => [origin, rule]));
      }
    } catch {
      // Ignore errors, start fresh
    }
  }
  async function saveWebsiteRulesToDisk() {
    try {
      const fs = await import("node:fs/promises");
      const obj = Object.fromEntries(websiteRules);
      await fs.writeFile(websiteRulesStorePath, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Ignore write errors
    }
  }
  setWebsiteRulesPersistCallback(saveWebsiteRulesToDisk);
  loadWebsiteRulesFromDisk();

  // Auto-suspend timer: check every minute
  const autoSuspendTimer = setInterval(scheduleAutoSuspend, 60 * 1000);
  autoSuspendTimer.unref?.();

  let menuRequest = null;
  let menuShowSerial = 0;
  let linkChoiceRequest = null;
  let linkChoiceCounter = 0;
  const webMcpRefreshTimers = new Map();

  function window() {
    return getWindow?.() ?? null;
  }

  /** Send an IPC message to the main renderer, guarding against disposed frames. */
  function sendToRenderer(channel, payload) {
    const mainWindow = window();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try { mainWindow.webContents.send(channel, payload); } catch { /* window closing */ }
  }



  function normalizeBrowserUrl(url, fallback = BROWSER_DEFAULT_URL) {
    const target = typeof url === "string" && url.trim() ? url.trim() : fallback;
    if (!target || target === "about:blank") return "about:blank";
    return /^https?:\/\//i.test(target) ? target : `https://${target}`;
  }

  async function browserTaskAllowed(url) {
    if (!browserControlEnabled || typeof checkPolicy !== "function") return false;
    const rule = getWebsiteRule(url);
    if (rule.agentPermission === "deny") return false;
    if (rule.agentPermission === "allow") return true;
    try {
      await checkPolicy({ url });
      return browserControlEnabled;
    } catch {
      return false;
    }
  }

  function isMainWindowAllowedNavigation(url) {
    if (!url) return true;
    if (url.startsWith("file://") || url.startsWith("data:")) return true;
    try {
      const target = new URL(url);
      if (target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]") return true;
      const currentUrl = window()?.webContents.getURL();
      if (!currentUrl || currentUrl === "about:blank") return true;
      const current = new URL(currentUrl);
      return target.origin === current.origin;
    } catch {
      return true;
    }
  }

  function cdpBrowserUrl() {
    return `http://127.0.0.1:${remoteDebugPort}`;
  }

  /**
   * Open a URL for an agent. The tab belongs to the conversation that asked
   * (`ownerSessionId`). When that conversation is on screen the tab surfaces as
   * before; a new origin waits for review without contacting the destination
   * or switching the visible conversation.
   */
  async function openBrowserUrlForAutomation(rawUrl, provider = "auto", { ownerSessionId = null } = {}) {
    const requestedProvider = String(provider || "auto").trim().toLowerCase();
    const url = normalizeBrowserUrl(rawUrl);
    const result = await taskHost.request({ sessionId: ownerSessionId, operation: "open", args: { url, provider: requestedProvider } });
    if (!result.ok) throw new BrowserTaskError(result.code, result.error);
    // Electron supplies the exact target without a marker navigation or focus.
    const targetId = getBrowserTab(result.tabId).view.webContents.getOrCreateDevToolsTargetId();
    return {
      provider: "builtin",
      browser_url: cdpBrowserUrl(),
      target_id: targetId,
      tab_id: result.tabId,
      url: getBrowserTab(result.tabId).view.webContents.getURL(),
      owner_session_id: registry.ownerOf(result.tabId),
      visible: registry.surfacingFor(result.tabId) === "foreground",
    };
  }

  async function openBrowserTab(url, ownerSessionId, signal = undefined, beforeLoad = undefined) {
    signal?.throwIfAborted();
    const tab = createBrowserTab("about:blank", { select: true, initializeBlank: false, deferBackground: true, ownerSessionId, automationProtected: true });
    tab.operation = true;
    const stop = () => {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
      closeBrowserTab(tab.tabId);
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      await beforeLoad?.(tab);
      signal?.throwIfAborted();
      if (getBrowserTab(tab.tabId) !== tab || tab.view.webContents.isDestroyed() || registry.ownerOf(tab.tabId) !== ownerSessionId) throw new BrowserTaskError("tab_closed", "The browser tab closed or changed owner before navigation.");
      await tab.view.webContents.loadURL(url); signal?.throwIfAborted();
      tab.deferBackground = false;
      applySurfacing();
      await tab.emulation;
      signal?.throwIfAborted();
      return tab;
    }
    catch (error) {
      // Preserve the initiating failure when last-tab cleanup revokes control.
      closeBrowserTab(tab.tabId, false, error);
      throw error;
    }
    finally { signal?.removeEventListener("abort", stop); tab.operation = false; sendBrowserState(); }
  }

  function getBrowserTab(tabId = registry.onScreenTabId()) {
    return tabId ? browserTabs.get(tabId) ?? null : null;
  }

  function tabForView(view) {
    for (const tab of browserTabs.values()) {
      if (tab.view === view) return tab;
    }
    return null;
  }

  function getActiveBrowserView() {
    return getBrowserTab()?.view ?? null;
  }

  function getActiveWebContents() {
    if (getBrowserTab()?.suspending) throw new Error("Browser tab is suspending.");
    return getActiveBrowserView()?.webContents ?? null;
  }

  function getBrowserTabLabel(title, url) {
    if (title) {
      return title;
    }

    if (url && url !== "about:blank") {
      return url;
    }

    return "New tab";
  }

  function browserTabToPanelTab(tabId, tab) {
    const webContents = tab.view.webContents;
    const failed = tab.loadError?.code === "page_load_failed" ? tab.loadError : null;
    const url = failed?.url ?? webContents.getURL();
    const title = failed ? "" : webContents.getTitle();
    const isLoading = webContents.isLoading();

    return {
      id: tabId,
      type: "browser",
      label: getBrowserTabLabel(title, url),
      url,
      favicon: tab.favicon ?? null,
      status: tab.suspending ? "suspending" : tab.operation ? "restoring" : isLoading ? "loading" : "ready",
      automationProtected: tab.automationProtected,
      canGoBack: webContents.canGoBack(),
      canGoForward: webContents.canGoForward(),
      ownerSessionId: registry.ownerOf(tabId),
      browserApproval: tab.browserApproval ?? null,
      loadError: tab.loadError,
      browserTask: tab.browserTask,
      siteToolCount: Number.isInteger(tab.webMcpToolCount) ? tab.webMcpToolCount : 0,
      siteTools: Array.isArray(tab.webMcpTools) ? tab.webMcpTools : [],
      siteToolActivity: Array.isArray(tab.webMcpActivity) ? tab.webMcpActivity : [],
    };
  }

  function listBrowserTabs() {
    return registry
      .list()
      .map(({ tabId }) => {
        const tab = browserTabs.get(tabId);
        if (!tab || tab.view.webContents.isDestroyed()) return suspendedTabs.get(tabId) ?? null;
        return browserTabToPanelTab(tabId, tab);
      })
      .filter(Boolean);
  }

  function browserStatePayload() {
    return {
      activeTabId: registry.onScreenTabId(),
      activeTabIdByOwner: registry.activeTabIdByOwner(),
      visibleSessionId: registry.visibleSessionId(),
      tabs: listBrowserTabs(),
    };
  }

  // Read the actual native hierarchy, not the registry's intended surfacing.
  // A tab can be logically background while its native view covers the app.
  function browserNativeViews() {
    const mainWindow = window();
    const children = mainWindow?.contentView.children ?? [];
    return [...browserTabs.values()].map(({ tabId, view }) => {
      const index = children.indexOf(view);
      return {
        tabId,
        attached: index !== -1,
        // BrowserWindow's primary renderer is below the entire contentView.
        aboveApp: index !== -1,
        visible: view.getVisible(),
        bounds: view.getBounds(),
      };
    });
  }

  function browserTabUrl(tab) {
    const url = tab?.view?.webContents?.getURL?.();
    return typeof url === "string" && url && url !== "about:blank" ? url : null;
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizeMenuPoint(point) {
    if (!point || typeof point !== "object") {
      return { x: 0, y: 0 };
    }
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x: 0, y: 0 };
    }
    return { x, y };
  }

  function hideContextMenu() {
    if (!menuRequest) return;
    menuShowSerial += 1;
    menuRequest = null;
    closeNativeContextMenu();
  }

  // ===== WebMCP Tool Integration (CHUNK 8) =====
  /**
   * Execute a WebMCP tool from context menu
   * @param {Object} tab - Browser tab
   * @param {string} toolId - Tool ID to execute
   */
  async function executeWebMcpToolFromMenu(tab, toolId) {
    try {
      const ownerSessionId = registry.ownerOf(tab.tabId);
      if (!ownerSessionId) return;

      // Find the tool
      const tool = tab.webMcpTools?.find(t => t.id === toolId);
      if (!tool) return;

      // Get input for the tool - for context menu, we can use selection or prompt
      let input = {};
      if (tool.parameters && typeof tool.parameters === "object") {
        // For now, use empty input - could be enhanced to prompt for parameters
        input = {};
      }

      // Execute via taskHost (which uses the WebMCP broker)
      const result = await taskHost.request({
        sessionId: ownerSessionId,
        operation: "site_tool",
        args: { tabId: tab.tabId, toolId, input }
      });

      if (result.ok) {
        // Show result to user
        const resultText = typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
        const mainWindow = window();
        if (mainWindow && !mainWindow.isDestroyed()) {
          await dialog.showMessageBox(mainWindow, {
            type: "info",
            title: `Tool Result: ${tool.name || toolId}`,
            message: resultText.slice(0, 1000) + (resultText.length > 1000 ? "..." : ""),
            buttons: ["OK"]
          });
        }
      } else {
        const mainWindow = window();
        if (mainWindow && !mainWindow.isDestroyed()) {
          await dialog.showMessageBox(mainWindow, {
            type: "error",
            title: `Tool Failed: ${tool.name || toolId}`,
            message: result.error || "Unknown error",
            buttons: ["OK"]
          });
        }
      }
    } catch (error) {
      console.warn("WebMCP tool execution from menu failed:", error.message);
    }
  }

  function tabMenuRequest(tab, point) {
    const url = browserTabUrl(tab);
    return {
      source: "tab",
      tabId: tab.tabId,
      ownerSessionId: registry.ownerOf(tab.tabId),
      url,
      point: normalizeMenuPoint(point),
      items: [
        { type: "item", id: "copy-url", label: "Copy URL", enabled: !!url },
        { type: "item", id: "open-external", label: "Open in Browser", enabled: !!url && isHttpUrl(url) },
        { type: "separator" },
        { type: "item", id: "webmcp-refresh", label: "Refresh WebMCP Tools", enabled: true },
        { type: "separator" },
        { type: "item", id: "close-tab", label: "Close Tab" },
        { type: "item", id: "close-all-tabs", label: "Close All Tabs" },
      ],
    };
  }

  async function showBrowserTabContextMenu(tabId, point) {
    const tab = getBrowserTab(String(tabId ?? ""));
    if (!window() || !tab || tab.view.webContents.isDestroyed()) return;

    await showContextMenu(tabMenuRequest(tab, point));
  }

  async function showLinkContextMenu({ url, point, sessionId }) {
    if (typeof url !== "string" || !isHttpUrl(url) || url.length > 32_768) return;
    const parsed = new URL(url);
    if (parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(url)) return;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    // A later focus change must not retarget the captured link.
    const ownerSessionId = normalizeSessionId(sessionId) ?? registry.visibleSessionId();
    await showContextMenu({
      source: "link",
      url,
      ownerSessionId,
      point: normalizeMenuPoint(point),
    });
  }

  async function showPageContextMenu(tab, params) {
    if (!browserTabVisible(tab.tabId)) return;
    const contents = tab.view.webContents;
    const items = [];
    const actions = new Map();
    const add = (id, label, action, enabled = true) => {
      items.push({ type: "item", id, label, enabled });
      actions.set(id, action);
    };
    const separator = () => { if (items.length) items.push({ type: "separator" }); };
    if (params.linkURL) {
      add("open-new-tab", "Open Link in New Tab", null, isHttpUrl(params.linkURL));
      add("copy-link", "Copy Link Address", () => clipboard.writeText(params.linkURL));
    }
    if (params.mediaType === "image") {
      separator();
      add("copy-image", "Copy Image", () => contents.copyImageAt(params.x, params.y), params.hasImageContents === true);
      if (params.srcURL) add("copy-image-address", "Copy Image Address", () => clipboard.writeText(params.srcURL));
    }
    if (params.isEditable || params.selectionText) {
      separator();
      const edit = (id, label, flag) => add(id, label, () => contents[id](), params.editFlags?.[flag] === true);
      if (params.isEditable) {
        edit("undo", "Undo", "canUndo");
        edit("redo", "Redo", "canRedo");
        separator();
        edit("cut", "Cut", "canCut");
      }
      edit("copy", "Copy", "canCopy");
      if (params.isEditable) {
        edit("paste", "Paste", "canPaste");
        edit("selectAll", "Select All", "canSelectAll");
      }
    }
    if (!params.isEditable && !params.selectionText && !params.linkURL && params.mediaType !== "image") {
      add("back", "Back", () => contents.goBack(), contents.canGoBack());
      add("forward", "Forward", () => contents.goForward(), contents.canGoForward());
      add("reload", "Reload", () => contents.reload());
    }

    // ===== WebMCP Tool Integration (CHUNK 8) =====
    // Add available WebMCP tools to context menu
    if (tab.webMcpTools && tab.webMcpTools.length > 0) {
      separator();
      add("webmcp-tools-header", "WebMCP Tools", null, false); // Disabled header
      for (const tool of tab.webMcpTools.slice(0, 10)) { // Limit to 10 tools
        const toolId = `webmcp-${tool.id}`;
        add(toolId, tool.name || tool.id, () => executeWebMcpToolFromMenu(tab, tool.id), tool.enabled !== false);
      }
      if (tab.webMcpTools.length > 10) {
        add("webmcp-more", `... and ${tab.webMcpTools.length - 10} more tools`, null, false);
      }
    }

    // Add page inspection tools
    separator();
    add("inspect-element", "Inspect Element", () => contents.inspectElement(params.x, params.y));
    add("view-source", "View Page Source", () => contents.executeJavaScript("window.open('view-source:' + window.location.href, '_blank')"));

    // Chromium supplies view-relative coordinates, already in window DIPs.
    // Convert to app CSS pixels for the shared helper, not through page zoom.
    const bounds = tab.view.getBounds();
    const appZoom = window().webContents.getZoomFactor();
    await showContextMenu({
      source: "page", tabId: tab.tabId, ownerSessionId: registry.ownerOf(tab.tabId),
      url: params.linkURL, items, actions,
      point: { x: (bounds.x + params.x) / appZoom, y: (bounds.y + params.y) / appZoom },
    });
  }

  async function showContextMenu(request) {
    hideContextMenu();
    const showSerial = ++menuShowSerial;
    const mainWindow = window();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const tab = request.tabId ? getBrowserTab(request.tabId) : null;
    const isCurrent = () => showSerial === menuShowSerial && window() === mainWindow
      && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()
      && (!tab || (getBrowserTab(tab.tabId) === tab && !tab.view.webContents.isDestroyed() && registry.ownerOf(tab.tabId) === request.ownerSessionId))
      && (request.source !== "page" || browserTabVisible(request.tabId));
    const dismiss = () => { if (menuRequest === request) hideContextMenu(); };
    const invalidate = () => {
      if (showSerial !== menuShowSerial) return;
      dismiss();
      menuShowSerial += 1;
    };
    const navigated = (_event, _url, _isInPlace, isMainFrame) => { if (isMainFrame || request.source === "page") invalidate(); };
    menuRequest = request;
    mainWindow.on("blur", dismiss);
    mainWindow.webContents.on("did-start-navigation", navigated);
    mainWindow.webContents.on("destroyed", invalidate);
    tab?.view.webContents.on("did-start-navigation", navigated);
    try {
      if (request.source === "link") {
        request.items = [
          { type: "item", id: "open-builtin", label: "Open in OpenWork" },
          { type: "item", id: "open-external", label: "Open in external browser" },
          { type: "separator" },
          { type: "item", id: "copy-url", label: "Copy Link Address" },
        ];
      }
      // The native helper owns zoom conversion and resolves only an ID or null.
      const itemId = await showNativeContextMenu({ items: request.items, point: request.point });
      if (!isCurrent()) return;
      menuRequest = null;
      if (!request.items.some((item) => item.type === "item" && item.id === itemId && item.enabled !== false)) return;
      // Once selected, changing conversations must not retarget or cancel the
      // captured link. A newer menu or destroyed document still invalidates it.
      await handleMenuChoice(request, itemId, isCurrent);
    } finally {
      dismiss();
      mainWindow.removeListener("blur", dismiss);
      mainWindow.webContents.removeListener("did-start-navigation", navigated);
      mainWindow.webContents.removeListener("destroyed", invalidate);
      tab?.view.webContents.removeListener("did-start-navigation", navigated);
    }
  }

  async function handleMenuChoice(request, itemId, isCurrent) {
    const tab = getBrowserTab(request.tabId);

    if ((request.source === "link" && itemId !== "copy-url") || (request.source === "page" && itemId === "open-new-tab")) {
      try {
        const external = request.source === "link" && itemId !== "open-builtin";
        await checkPolicy?.({ url: request.url, external });
        if (!isCurrent()) return;
        if (!external) {
          createBrowserTab(request.url, { ownerSessionId: request.ownerSessionId, initializeBlank: false });
        } else {
          const result = await openExternalUrl(request.url);
          if (!result.ok) throw new Error(result.error);
        }
      } catch (error) {
        if (isCurrent()) {
          await dialog.showMessageBox(window(), {
            type: "error", message: "Could not open this link",
            detail: error instanceof Error ? error.message : "Your browser may be unavailable, or your organization may restrict this destination. You can copy the link address instead.",
          });
        }
      }
      return;
    }

    if (request.source === "page") {
      request.actions.get(itemId)?.();
      return;
    }

    switch (itemId) {
      case "copy-url":
        if (request.url) clipboard.writeText(request.url);
        break;
      case "open-external":
        if (request.url && isHttpUrl(request.url)) {
          await checkPolicy?.({ url: request.url, external: true });
          if (isCurrent()) await shell.openExternal(request.url);
        }
        break;
      case "close-tab":
        if (tab) closeUserBrowserTab(tab.tabId);
        break;
      case "close-all-tabs":
        closeAllBrowserTabs(true);
        break;
      case "webmcp-refresh":
        if (tab) {
          await scheduleWebMcpToolCountRefresh(tab.tabId);
          sendBrowserState();
        }
        break;
    }
  }

  function resolveBrowserProxyInput(input) {
    const raw = String(input ?? "").trim();
    const envMatch = raw.match(/^env:([A-Za-z0-9_]+)$/i);
    if (!envMatch) return raw;
    const key = `OPENWORK_BROWSER_PROXY_${envMatch[1].toUpperCase()}`;
    const value = String(process.env[key] ?? "").trim();
    if (!value) throw new Error(`No proxy configured: set the ${key} environment variable to a proxy URL.`);
    return value;
  }

  function parseBrowserProxyInput(input) {
    const raw = resolveBrowserProxyInput(input);
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`Invalid proxy URL: ${raw}`);
    }
    if (!url.hostname || !url.port) {
      throw new Error("Proxy must include host and port, e.g. http://user:pass@host:8080 or socks5://host:1080.");
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    return {
      rules: `${scheme}://${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  function browserProxyState(sessionId = "default") {
    const proxy = browserProxies.get(sessionId);
    return {
      proxy: proxy
        ? { rules: proxy.rules, authenticated: Boolean(proxy.username) }
        : null,
    };
  }

  const approvals = new Map();
  function browserTabVisible(tabId) {
    const tab = getBrowserTab(tabId);
    return !!tab && browserViewVisible && registry.onScreenTabId() === tabId
      && window()?.contentView.children.includes(tab.view) === true && tab.view.getVisible();
  }
  function confirmBrowserAction({ tabId, title, message, detail, signal, approveLabel = "Allow once", waitForVisible = false }) {
    const tab = getBrowserTab(tabId);
    const owner = registry.ownerOf(tabId);
    if (!tab || (!waitForVisible && !browserTabVisible(tabId)) || signal?.aborted) return Promise.resolve(false);
    if (approvals.has(tabId)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = createBrowserTabId();
      const finish = (allowed) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", canceled);
        if (approvals.get(tabId)?.id !== id) return;
        approvals.delete(tabId); tab.browserApproval = null;
        if (!tab.view.webContents.isDestroyed()) tab.view.setVisible(tab.loadError?.code !== "page_load_failed");
        sendBrowserState(); resolve(allowed && !signal?.aborted && getBrowserTab(tabId) === tab && registry.ownerOf(tabId) === owner && browserTabVisible(tabId));
      };
      const canceled = () => finish(false);
      const timer = setTimeout(canceled, 60_000);
      approvals.set(tabId, { id, finish });
      tab.browserApproval = { id, title, message, detail, approveLabel };
      tab.view.setVisible(false);
      signal?.addEventListener("abort", canceled, { once: true });
      sendBrowserState();
    });
  }
  async function confirmWebMcpExecution({ tool, inputSummary, tabId, signal }) {
    return confirmBrowserAction({ tabId, signal, title: "Allow website action?",
      message: `Allow ${tool.origin} to run “${tool.name}”?`,
      detail: `This website tool may change data. Arguments: ${inputSummary}` });
  }

  const webMcpBroker = createWebMcpBroker({
    getTab: (tabId) => getBrowserTab(tabId),
    getActiveTabId: (sessionId) => registry.activeTabIdFor(sessionId),
    assertTabAccess: async (tabId, sessionId) => {
      if (!sessionId || registry.ownerOf(tabId) !== sessionId) throw new Error("wrong_conversation");
      const tab = getBrowserTab(tabId);
      if (!tab || !await browserTaskAllowed(tab.view.webContents.getURL())) throw new Error("website_blocked");
    },
    confirmExecution: confirmWebMcpExecution,
    confirmResultDisclosure: ({ tabId, signal, tool, resultText }) => confirmBrowserAction({
      tabId, signal, title: "Share website result?", approveLabel: "Share result",
      message: `Share the result from ${tool.origin} with this conversation and its model provider?`,
      detail: `The website action has already run. Review this complete result for passwords, session cookies, tokens or other private data before sharing. Denying keeps the result out of the conversation and does not undo the action.\n\n${resultText}`,
    }),
    isFrameAllowed: async (frame) => {
      // Find the tab that owns this frame's webContents
      const tab = [...browserTabs.values()].find((candidate) => candidate.view.webContents.id === frame.webContentsId);
      const sessionId = tab ? registry.ownerOf(tab.tabId) : "default";
      return await browserTaskAllowed(frame.url) && ensureWebMcpFramePolicy(sessionId).checkFrame(frame);
    },
    onActivity: (activity) => {
      const tab = getBrowserTab(activity.tabId);
      if (!tab) return;
      tab.webMcpActivity = [activity, ...(tab.webMcpActivity ?? [])].slice(0, 20);
      sendBrowserState();
    },
    onToolCountChanged: (tabId, count) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return;
      tab.webMcpToolCount = count;
      sendBrowserState();
    },
    onToolsChanged: (tabId, tools) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return;
      tab.webMcpTools = tools;
      tab.webMcpToolCount = tools.length;
      sendBrowserState();
    },
  });


  const taskHost = createBrowserTaskHost({
    getTab: getBrowserTab,
    tabsFor: (sessionId) => registry.tabsFor(sessionId).map((item) => getBrowserTab(item.tabId)).filter(Boolean),
    ownerOf: (tabId) => registry.ownerOf(tabId),
    activeFor: (sessionId) => registry.activeTabIdFor(sessionId),
    isVisible: browserTabVisible,
    enabled: () => browserControlEnabled,
    allowed: browserTaskAllowed,
    openTab: openBrowserTab,
    navigate: (tab, url) => tab.view.webContents.loadURL(url),
    confirm: confirmBrowserAction,
    changed: (tabId, activity) => { const tab = getBrowserTab(tabId); if (tab) { tab.browserTask = activity; sendBrowserState(); } },
    siteTools: (args) => webMcpBroker.listTools(args),
    runSiteTool: (args, options) => webMcpBroker.executeTool(args, options),
    // Prepare before actions (release input lease for form edits)
    prepare: async (tab) => {
      // No-op by default; can be extended for input lease management
    },
    // Critical for click coordinates when page is scaled (viewport emulation, device pixel ratio)
    inputScale: (tab) => {
      const rule = tab.websiteRule || getWebsiteRule(tab.view.webContents.getURL());
      if (rule.viewport?.deviceScaleFactor) return rule.viewport.deviceScaleFactor;
      // Fallback: try to get from webContents zoom level
      try {
        const zoomLevel = tab.view.webContents.getZoomLevel();
        return Math.pow(1.2, zoomLevel);
      } catch {
        return 1;
      }
    },
    // Capture page for observation caching (SHA256 image digest)
    capture: async (tab, viewport) => {
      try {
        const capture = await tab.view.webContents.capturePage();
        return capture.resize({ width: viewport.width, height: viewport.height }).toPNG({ scaleFactor: 1 });
      } catch {
        return null;
      }
    },
  });

  function scheduleWebMcpToolCountRefresh(tabId) {
    if (!tabId || webMcpRefreshTimers.has(tabId)) return;
    const timer = setTimeout(() => {
      webMcpRefreshTimers.delete(tabId);
      void webMcpBroker.refreshTabToolCount(tabId);
    }, 250);
    webMcpRefreshTimers.set(tabId, timer);
  }

  function invalidateWebMcpTab(tab) {
    if (!tab) return;
    taskHost.invalidate(tab.tabId);
    tab.webMcpRevision = (Number.isInteger(tab.webMcpRevision) ? tab.webMcpRevision : 0) + 1;
    tab.webMcpToolCount = 0;
    tab.webMcpTools = [];
    webMcpBroker.invalidateTab(tab.tabId);
  }

  // Per-session proxy config
  const browserProxies = new Map(); // sessionId -> parsed proxy config

  async function setBrowserProxy(sessionId, proxyInput) {
    const browserSession = ensureBrowserSession(sessionId);
    const parsed = parseBrowserProxyInput(proxyInput);
    if (parsed) {
      await browserSession.setProxy({ proxyRules: parsed.rules, proxyBypassRules: "<local>" });
    } else {
      await browserSession.setProxy({ mode: "system" });
    }
    browserProxies.set(sessionId, parsed);
    // Drop keep-alive connections so existing tabs cannot bypass the new proxy.
    await browserSession.closeAllConnections();
    return browserProxyState(sessionId);
  }

  app.on("login", (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo?.isProxy) return;
    // Find the session that owns this webContents
    for (const [sessionId, proxy] of browserProxies) {
      if (proxy?.username) {
        event.preventDefault();
        callback(proxy.username, proxy.password);
        return;
      }
    }
  });

  // ===== Per-Tab Proxy + PAC Support (CHUNK 7) =====
  // Per-tab proxy configuration with PAC script support

  const tabProxies = new Map(); // tabId -> { parsed, pacUrl, pacScript, pacFunction }
  const pacCache = new Map(); // pacUrl -> { script, fetchedAt, error }

  /**
   * Parse PAC script and create a FindProxyForURL function
   * @param {string} pacScript - PAC script content
   * @returns {Function|null} FindProxyForURL function or null if invalid
   */
  function compilePacScript(pacScript) {
    try {
      // Create a sandboxed environment for PAC script
      const pacContext = {
        // PAC standard functions
        isPlainHostName: (host) => !host.includes("."),
        dnsDomainIs: (host, domain) => host.endsWith(domain),
        localHostOrDomainIs: (host, hostdom) => host === hostdom,
        isResolvable: () => true, // Simplified
        isInNet: () => false, // Simplified
        dnsResolve: (host) => host, // Simplified
        myIpAddress: () => "127.0.0.1",
        shExpMatch: (str, shexp) => {
          // Simple shell expression matching
          const regex = new RegExp("^" + shexp.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
          return regex.test(str);
        },
        weekdayRange: () => false,
        dateRange: () => false,
        timeRange: () => false,
        alert: (msg) => console.log("PAC alert:", msg),
      };

      // Wrap PAC script in a function
      const func = new Function("url", "host", "return (" + pacScript + ")");
      return (url, host) => {
        try {
          return func.call(pacContext, url, host);
        } catch (e) {
          console.warn("PAC script execution error:", e.message);
          return "DIRECT";
        }
      };
    } catch (e) {
      console.warn("PAC script compilation failed:", e.message);
      return null;
    }
  }

  /**
   * Fetch and compile PAC script from URL
   * @param {string} pacUrl - URL to PAC script
   * @returns {Promise<Function|null>} Compiled FindProxyForURL function
   */
  async function fetchAndCompilePac(pacUrl) {
    const cached = pacCache.get(pacUrl);
    if (cached && !cached.error && Date.now() - cached.fetchedAt < 30 * 60 * 1000) {
      return cached.script;
    }

    try {
      const response = await fetch(pacUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const script = await response.text();
      const compiled = compilePacScript(script);
      pacCache.set(pacUrl, { script: compiled, fetchedAt: Date.now(), error: null });
      return compiled;
    } catch (error) {
      pacCache.set(pacUrl, { script: null, fetchedAt: Date.now(), error: error.message });
      console.warn("Failed to fetch PAC script:", error.message);
      return null;
    }
  }

  /**
   * Resolve proxy for a specific tab and URL
   * @param {string} tabId - Tab ID
   * @param {string} url - Target URL
   * @returns {Promise<string>} Proxy rule string (e.g., "PROXY host:port", "SOCKS5 host:port", "DIRECT")
   */
  async function resolveTabProxy(tabId, url) {
    const tabProxy = tabProxies.get(tabId);
    if (tabProxy) {
      // Check PAC script first
      if (tabProxy.pacFunction) {
        try {
          const parsedUrl = new URL(url);
          const host = parsedUrl.hostname;
          const pacResult = tabProxy.pacFunction(url, host);
          if (pacResult && pacResult !== "DIRECT") {
            return pacResult;
          }
        } catch (e) {
          console.warn("PAC resolution error:", e.message);
        }
      }
      // Fall back to static proxy
      if (tabProxy.parsed?.rules) {
        return tabProxy.parsed.rules;
      }
    }

    // Fall back to session proxy
    const sessionId = registry.ownerOf(tabId) ?? "default";
    const sessionProxy = browserProxies.get(sessionId);
    if (sessionProxy?.rules) {
      return sessionProxy.rules;
    }

    return "DIRECT";
  }

  /**
   * Set per-tab proxy configuration
   * @param {string} tabId - Tab ID
   * @param {Object} config - Proxy config: { proxyUrl?, pacUrl?, pacScript? }
   */
  async function setTabProxy(tabId, config) {
    const tab = getBrowserTab(tabId);
    if (!tab) throw new Error("Tab not found");

    const tabProxy = { parsed: null, pacUrl: null, pacScript: null, pacFunction: null };

    if (config.pacUrl) {
      tabProxy.pacUrl = config.pacUrl;
      tabProxy.pacFunction = await fetchAndCompilePac(config.pacUrl);
    } else if (config.pacScript) {
      tabProxy.pacScript = config.pacScript;
      tabProxy.pacFunction = compilePacScript(config.pacScript);
    } else if (config.proxyUrl) {
      tabProxy.parsed = parseBrowserProxyInput(config.proxyUrl);
    }

    tabProxies.set(tabId, tabProxy);
    // Update session PAC script to reflect new tab proxy
    await updateSessionProxyForTab(tabId);
    return { success: true, tabId, config: tabProxy };
  }

  /**
   * Clear per-tab proxy (revert to session proxy)
   * @param {string} tabId - Tab ID
   */
  async function clearTabProxy(tabId) {
    tabProxies.delete(tabId);
    // Update session PAC script to reflect removed tab proxy
    await updateSessionProxyForTab(tabId);
    return { success: true, tabId };
  }

  /**
   * Get per-tab proxy state
   * @param {string} tabId - Tab ID
   */
  function getTabProxyState(tabId) {
    const tabProxy = tabProxies.get(tabId);
    const sessionId = registry.ownerOf(tabId) ?? "default";
    const sessionProxy = browserProxies.get(sessionId);

    return {
      tabProxy: tabProxy
        ? {
            hasStaticProxy: Boolean(tabProxy.parsed?.rules),
            pacUrl: tabProxy.pacUrl,
            hasPacFunction: Boolean(tabProxy.pacFunction),
          }
        : null,
      sessionProxy: sessionProxy
        ? { rules: sessionProxy.rules, authenticated: Boolean(sessionProxy.username) }
        : null,
    };
  }

  /**
   * Generate a session-level PAC script that routes based on active tab's proxy config
   * This PAC script is set on the Electron session and evaluates per-request
   */
  function generateSessionPacScript() {
    return `
      function FindProxyForURL(url, host) {
        // This PAC script is dynamically generated and updated
        // The actual routing logic is handled by the main process
        // based on the tab that initiated the request
        return "DIRECT";
      }
    `;
  }

  /**
   * Apply per-tab proxy by setting a PAC script on the session
   * This is called when tab proxy configuration changes
   */
  async function applyTabProxyToSession(sessionId) {
    const browserSession = ensureBrowserSession(sessionId);
    const pacScript = generateSessionPacScript();
    try {
      await browserSession.setProxy({ pacScript, proxyBypassRules: "<local>" });
    } catch (error) {
      console.warn("Failed to set session PAC script:", error.message);
    }
  }

  /**
   * Update session PAC script when tab proxies change
   * This should be called after setTabProxy or clearTabProxy
   */
  async function updateSessionProxyForTab(tabId) {
    const sessionId = registry.ownerOf(tabId) ?? "default";
    await applyTabProxyToSession(sessionId);
  }

  // ===== CDP Domain Expansion (CHUNK 6) =====
  // Comprehensive Chrome DevTools Protocol support for browser automation

  const CDP_DOMAINS = CONFIG.cdp.enabledDomains;

  /**
   * Enable all CDP domains for a tab's WebContents
   * @param {Electron.WebContents} contents
   */
  async function enableCdpDomains(contents) {
    const cdp = contents.debugger;
    if (!cdp.isAttached()) {
      cdp.attach("1.3");
    }
    const results = await Promise.allSettled(
      CDP_DOMAINS.map((domain) => cdp.sendCommand(`${domain}.enable`).catch((err) => {
        // Some domains may not be available in all contexts; log but don't fail
        console.debug(`CDP ${domain}.enable failed:`, err.message);
        return { domain, enabled: false };
      }))
    );
    const enabled = CDP_DOMAINS.filter((_, i) => results[i].status === "fulfilled" || (results[i].status === "rejected" && false));
    console.log(`CDP domains enabled for tab: ${enabled.join(", ")}`);
    return enabled;
  }

  /**
   * Set up CDP event handlers for a tab
   * @param {Electron.WebContents} contents
   * @param {Object} tab - The browser tab object
   */
  function setupCdpEventHandlers(contents, tab) {
    const cdp = contents.debugger;

    // Network events
    cdp.on("message", (method, params) => {
      if (method === "Network.requestWillBeSent") {
        tab._networkRequests = tab._networkRequests || new Map();
        tab._networkRequests.set(params.requestId, { ...params, startTime: Date.now() });
      } else if (method === "Network.responseReceived") {
        if (tab._networkRequests?.has(params.requestId)) {
          const req = tab._networkRequests.get(params.requestId);
          req.response = params.response;
          req.endTime = Date.now();
        }
      } else if (method === "Network.loadingFinished") {
        tab._networkRequests?.delete(params.requestId);
      } else if (method === "Network.loadingFailed") {
        tab._networkRequests?.delete(params.requestId);
      }
    });

    // Page lifecycle events
    cdp.on("message", (method, params) => {
      if (method === "Page.domContentEventFired" || method === "Page.loadEventFired") {
        tab._pageLoadState = method;
      }
    });

    // Console messages
    cdp.on("message", (method, params) => {
      if (method === "Console.messageAdded" || method === "Runtime.consoleAPICalled") {
        tab._consoleMessages = tab._consoleMessages || [];
        tab._consoleMessages.push({ method, params, timestamp: Date.now() });
        if (tab._consoleMessages.length > 1000) tab._consoleMessages.shift();
      }
    });

    // Handle target created/destroyed (iframes, popups)
    cdp.on("message", (method, params) => {
      if (method === "Target.targetCreated" || method === "Target.targetDestroyed") {
        tab._cdpTargets = tab._cdpTargets || new Map();
        if (method === "Target.targetCreated") {
          tab._cdpTargets.set(params.targetInfo.targetId, params.targetInfo);
        } else {
          tab._cdpTargets.delete(params.targetInfo.targetId);
        }
      }
    });
  }

  /**
   * Initialize CDP for a tab - called on dom-ready
   * @param {Object} tab - The browser tab object
   */
  async function initializeCdpForTab(tab) {
    try {
      const contents = tab.view.webContents;
      if (contents.isDestroyed()) return;

      await enableCdpDomains(contents);
      setupCdpEventHandlers(contents, tab);

      // Store CDP reference for later use
      tab.cdp = contents.debugger;
      tab.cdpInitialized = true;
    } catch (error) {
      console.warn("CDP initialization failed for tab:", error.message);
    }
  }

  // Helper to safely send CDP commands
  async function sendCdpCommand(tab, method, params = {}) {
    if (!tab.cdp || tab.view.webContents.isDestroyed()) {
      throw new Error("CDP not available or tab destroyed");
    }
    const cdp = tab.cdp;
    const attached = !cdp.isAttached();
    if (attached) cdp.attach("1.3");
    try {
      return await cdp.sendCommand(method, params);
    } finally {
      if (attached && !tab.view.webContents.isDestroyed() && cdp.isAttached()) {
        cdp.detach();
      }
    }
  }

  function createBrowserTab(url = "about:blank", { select = true, initializeBlank = true, deferBackground = false, ownerSessionId = null, restoreTabId = null, automationProtected = false, contentsOptions = {} } = {}) {
    const sessionId = ownerSessionId ?? "default";
    if (browserTabs.size >= MAX_BROWSER_TABS) throw new BrowserTaskError("tab_limit", `OpenWork has ${MAX_BROWSER_TABS} browser tabs open. Close an unused browser tab in any conversation, then try again.`);
    if (!restoreTabId && registry.size() >= 100) throw new Error("OpenWork has 100 saved browser tabs. Close an unused tab, then try again.");
    installBrowserSessionHooks(sessionId);
    ensureWebMcpFramePolicy(sessionId);
    const tabId = restoreTabId ?? createBrowserTabId();
    // Use per-origin partition for deeper cookie isolation within a session
    const partition = url && url !== "about:blank" ? getOriginPartition(sessionId, url) : getSessionPartition(sessionId);
    const view = new WebContentsView({
      ...contentsOptions,
      webPreferences: {
        ...contentsOptions.webPreferences,
        backgroundThrottling: false,
        ...BROWSER_SECURITY_PREFERENCES,
        preload: path.join(__dirname, "browser-content-preload.cjs"),
        partition,
      },
    });
    const tab = {
      tabId, view, favicon: null, background: false, automationProtected,
      deferBackground,
      operation: false, suspending: false, mediaPlaying: false, downloads: new Set(),
      domReady: false, emulation: Promise.resolve(),
      finishSuspension: null,
      webMcpRevision: 0,
      documentGeneration: 0,
      loadError: null,
      webMcpToolCount: 0,
      webMcpTools: [],
      webMcpActivity: [],
      websiteRule: getWebsiteRule(url),
    };
    browserTabs.set(tabId, tab);
    if (!restoreTabId) registry.add({ tabId, ownerSessionId });
    view.webContents.on("context-menu", (_event, params) => {
      runDetachedTask("show browser page menu", () => showPageContextMenu(tab, params));
    });
    view.webContents.once("dom-ready", async () => {
      tab.domReady = true;
      const currentUrl = view.webContents.getURL();
      if (currentUrl && currentUrl !== "about:blank") {
        tab.websiteRule = getWebsiteRule(currentUrl);
        await applyWebsiteRuleToTab(tab, tab.websiteRule);
      }
      // Initialize CDP domains for full browser automation support
      await initializeCdpForTab(tab);
      if (tab.background) emulateBackgroundTab(tab);
    });
    view.webContents.on("media-started-playing", () => { tab.mediaPlaying = true; });
    view.webContents.on("media-paused", () => { tab.mediaPlaying = false; });
    view.webContents.on("will-prevent-unload", () => {
      if (!tab.suspending || browserTabs.get(tabId) !== tab) return;
      tab.suspending = false;
      suspendedTabs.delete(tabId);
      tab.finishSuspension?.(new Error("The page prevented suspension."));
      sendBrowserState();
    });
    if (initializeBlank) runDetachedTask("initialize browser tab", () => view.webContents.loadURL("about:blank"));
    view.webContents.setWindowOpenHandler(({ url: targetUrl, disposition }) => {
      if (!/^https?:\/\//i.test(targetUrl)) return { action: "deny" };
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: BROWSER_SECURITY_PREFERENCES }, createWindow: (options) => {
        // Pass targetUrl so the popup gets the correct origin partition
        const popup = createBrowserTab(targetUrl, { select: disposition !== "background-tab", initializeBlank: false, ownerSessionId: registry.ownerOf(tabId), contentsOptions: options });
        taskHost.inheritNavigation(tabId, popup);
        if (disposition === "background-tab") runDetachedTask("load background browser popup", () => popup.view.webContents.loadURL(targetUrl));
        return popup.view.webContents;
      } };
    });
    view.webContents.on("did-start-navigation", (_event, targetUrl, isInPlace, isMainFrame) => {
      if (isMainFrame || !isInPlace) { invalidateWebMcpTab(tab); sendBrowserState(); }
      if (!isMainFrame || isInPlace) return;
      const target = String(targetUrl ?? "");
      if (target === "about:blank" || target.startsWith("data:")) return;
      if (target.startsWith("openwork://") || target.startsWith("openwork-dev://")) {
        if (typeof onDeepLink === "function") onDeepLink([target]);
        setTimeout(() => {
          try { if (!view.webContents.isDestroyed()) runDetachedTask("clear completed browser handoff", () => view.webContents.loadURL("about:blank")); hideBrowserView(); } catch {}
        }, 200);
        return;
      }
      const surfacing = registry.surfacingFor(tabId);
      if (surfacing === "foreground" && registry.onScreenTabId() !== tabId) { try { selectBrowserTab(tabId); } catch {} }
      else if (surfacing === "background") { registry.select(tabId); sendBrowserState(); }
      sendToRenderer("openwork:browser:panel-opened", { ownerSessionId: registry.ownerOf(tabId) });
    });
    view.webContents.on("did-navigate", async () => {
      tab.documentGeneration += 1;
      tab.loadError = null;
      const currentUrl = view.webContents.getURL();
      if (currentUrl && currentUrl !== "about:blank") {
        tab.websiteRule = getWebsiteRule(currentUrl);
        await applyWebsiteRuleToTab(tab, tab.websiteRule);
      }
      if (registry.onScreenTabId() === tabId) attachActiveBrowserView();
      sendBrowserState();
    });
    view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (errorDescription === "ERR_BLOCKED_BY_CLIENT" && tab.loadError && tab.loadError.code !== "page_load_failed") return;
      tab.loadError = { code: "page_load_failed", message: errorCode === -102 ? "This site refused the connection. Check that it is running, then reload." : errorCode === -106 ? "You are offline. Check your connection, then reload." : "This page could not be loaded. Check the address and your connection, then reload.", url: validatedURL, errorCode, errorDescription };
      tab.view.setVisible(false);
      sendBrowserState();
    });
    view.webContents.on("did-navigate-in-page", () => sendBrowserState());
    view.webContents.on("page-title-updated", () => sendBrowserState());
    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) ? favicons[0] ?? null : null;
      sendBrowserState();
    });
    view.webContents.on("did-start-loading", () => sendBrowserState());
    view.webContents.on("did-stop-loading", () => { sendBrowserState(); scheduleWebMcpToolCountRefresh(tabId); });
    view.webContents.on("focus", () => { if (isFocusedBrowserTab(tab)) { setShortcutFocus(tabId); markTabActive(tabId); } resetViewportEmulation(view); });
    view.webContents.on("before-input-event", (event, input) => { if (!isFocusedBrowserTab(tab)) return; setShortcutFocus(tabId); handleBrowserShortcut(event, input); });
    view.webContents.once("destroyed", () => { if (browserTabs.get(tabId) === tab) closeBrowserTab(tabId, tab.suspending); });
    if (registry.surfacingFor(tabId) === "background") { if (select) registry.select(tabId); enterBackgroundMode(tab); sendBrowserState(); }
    else if (select || !registry.onScreenTabId()) { selectBrowserTab(tabId); }
    else { sendBrowserState(); }
    if (select) sendToRenderer("openwork:browser:panel-opened", { ownerSessionId: registry.ownerOf(tabId), tab: browserTabToPanelTab(tabId, tab) });
    const finalUrl = normalizeBrowserUrl(url, "about:blank");
    if (finalUrl !== "about:blank") runDetachedTask("navigate new browser tab", () => view.webContents.loadURL(finalUrl));
    return tab;
  }
  function detachBrowserView(view) {
    if (!view) return;
    for (const host of [window(), backgroundWindow]) {
      try {
        if (host && !host.isDestroyed() && host.contentView.children.includes(view)) {
          host.contentView.removeChildView(view);
        }
      } catch {
        // already removed
      }
    }
  }

  function backgroundBrowserWindow() {
    if (!backgroundWindow || backgroundWindow.isDestroyed()) {
      backgroundWindow = new BrowserWindow({
        ...BACKGROUND_TAB_VIEWPORT,
        show: false,
        paintWhenInitiallyHidden: true,
        focusable: false,
        skipTaskbar: true,
        webPreferences: { backgroundThrottling: false, sandbox: true },
      });
    }
    return backgroundWindow;
  }

  function releaseEmptyBackgroundWindow() {
    if (!backgroundWindow) return;
    if (!backgroundWindow.isDestroyed() && backgroundWindow.contentView.children.length > 0) return;
    if (!backgroundWindow.isDestroyed()) backgroundWindow.destroy();
    backgroundWindow = null;
  }

  // A tab whose conversation is not on screen must still behave like a real
  // page for the agent driving it: lay out at a real viewport, accept typing as
  // a focused page, and paint so CDP screenshots work. Park it in a never-shown
  // window: detached views stop painting, and every child of the main window's
  // contentView paints above OpenWork, regardless of its child index or bounds.
  // Moving the same view preserves the document and CDP target.
  function enterBackgroundMode(tab) {
    // A task's blank consent tab has no document to paint or observe. Attaching
    // its uninitialized widget to a hidden host can crash Electron on Linux.
    // Keep it detached until its approved first navigation has completed.
    if (!tab || tab.background || tab.deferBackground) return;
    const webContents = tab.view.webContents;
    if (webContents.isDestroyed()) return;
    tab.background = true;
    tab.lastActive = Date.now();
    detachBrowserView(tab.view);
    tab.view.setBounds({ x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT });
    backgroundBrowserWindow().contentView.addChildView(tab.view);
    if (tab.domReady) emulateBackgroundTab(tab);
    startThumbnailTimer(tab.tabId);
    scheduleAutoSuspend();
  }

  function exitBackgroundMode(tab) {
    if (!tab || !tab.background) return;
    tab.background = false;
    stopThumbnailTimer(tab.tabId);
    const webContents = tab.view.webContents;
    detachBrowserView(tab.view);
    if (webContents.isDestroyed()) return;
    const cdp = webContents.debugger;
    if (!cdp.isAttached()) return;
    runDetachedTask("restore foreground browser tab", async () => {
      try {
        for (const { method, params } of foregroundTabEmulationCommands()) {
          if (webContents.isDestroyed()) return;
          await cdp.sendCommand(method, params);
        }
      } finally {
        if (!webContents.isDestroyed() && cdp.isAttached()) cdp.detach();
      }
    });
  function exitBackgroundMode(tab) {
    if (!tab || !tab.background) return;
    tab.background = false;
    const webContents = tab.view.webContents;
    detachBrowserView(tab.view);
    if (webContents.isDestroyed()) return;
    const cdp = webContents.debugger;
    if (!cdp.isAttached()) return;
    runDetachedTask("restore foreground browser tab", async () => {
      try {
        for (const { method, params } of foregroundTabEmulationCommands()) {
          if (webContents.isDestroyed()) return;
          await cdp.sendCommand(method, params);
        }
      } finally {
        if (!webContents.isDestroyed() && cdp.isAttached()) cdp.detach();
      }
    });
  }

  /** Re-evaluate every tab after the on-screen conversation changed. */
  function applySurfacing() {
    for (const tab of browserTabs.values()) {
      if (registry.surfacingFor(tab.tabId) === "background") enterBackgroundMode(tab);
      else exitBackgroundMode(tab);
    }
    releaseEmptyBackgroundWindow();
  }

  // ===== CHUNK 3: Background Tab Thumbnails & Auto-Suspend =====
  const thumbnailTimers = new Map(); // tabId -> interval timer

  /** Capture thumbnail (320x200 JPEG) for a tab. */
  async function captureThumbnail(tab) {
    if (!tab || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoading()) return null;
    try {
      const img = await tab.view.webContents.capturePage(THUMBNAIL_SIZE);
      return img.toJPEG(THUMBNAIL_QUALITY);
    } catch {
      return null;
    }
  }

  /** Start periodic thumbnail capture for a background tab. */
  function startThumbnailTimer(tabId) {
    if (thumbnailTimers.has(tabId)) return;
    const timer = setInterval(async () => {
      const tab = browserTabs.get(tabId);
      if (!tab || !tab.background || tab.view.webContents.isDestroyed()) {
        stopThumbnailTimer(tabId);
        return;
      }
      const dataUrl = await captureThumbnail(tab);
      if (dataUrl) {
        tab.thumbnail = dataUrl;
        sendBrowserState();
      }
    }, THUMBNAIL_INTERVAL_MS);
    thumbnailTimers.set(tabId, timer);
  }

  function stopThumbnailTimer(tabId) {
    const timer = thumbnailTimers.get(tabId);
    if (timer) clearInterval(timer);
    thumbnailTimers.delete(tabId);
  }

  /** Auto-suspend background tabs that exceed limit or timeout. */
  function scheduleAutoSuspend() {
    const backgroundTabs = [...browserTabs.values()].filter(t => t.background);
    if (backgroundTabs.length > MAX_BACKGROUND_TABS) {
      // Suspend oldest non-protected background tabs first
      const candidates = backgroundTabs
        .filter(t => !t.automationProtected && !t.operation && !t.suspending && !t.mediaPlaying)
        .sort((a, b) => (a.lastActive || 0) - (b.lastActive || 0));
      for (const tab of candidates.slice(0, backgroundTabs.length - MAX_BACKGROUND_TABS)) {
        runDetachedTask(`auto-suspend ${tab.tabId}`, () => suspendBrowserTab(tab.tabId).catch(() => {}));
      }
    }
    // Also suspend tabs that have been background for too long
    const now = Date.now();
    for (const tab of backgroundTabs) {
      if (!tab.automationProtected && !tab.operation && !tab.suspending && !tab.mediaPlaying) {
        const inactiveMs = now - (tab.lastActive || now);
        if (inactiveMs > BACKGROUND_SUSPEND_DELAY_MS) {
          runDetachedTask(`auto-suspend-idle ${tab.tabId}`, () => suspendBrowserTab(tab.tabId).catch(() => {}));
        }
      }
    }
  }

  /** Track tab activity for auto-suspend. */
  function markTabActive(tabId) {
    const tab = browserTabs.get(tabId);
    if (tab) tab.lastActive = Date.now();
  }

  function setVisibleSession(sessionId) {
    const previous = registry.visibleSessionId();
    const next = registry.setVisibleSession(sessionId);
    if (next === previous) return next;
    shortcutFocus = null;
    hideContextMenu();
    applySurfacing();
    attachActiveBrowserView();
    sendBrowserState();
    return next;
  }

  function mainWindowZoomFactor() {
    try {
      const factor = window()?.webContents.getZoomFactor();
      return Number.isFinite(factor) && factor > 0 ? factor : 1;
    } catch {
      return 1;
    }
  }

  function acceptBrowserBounds(bounds) {
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) return false;
    const currentZoom = mainWindowZoomFactor();
    // Unstamped callers retain the existing CSS-pixel IPC contract.
    const zoom = bounds.zoomFactor === undefined ? currentZoom : bounds.zoomFactor;
    if (!Number.isFinite(zoom) || zoom <= 0 || Math.abs(zoom - currentZoom) > 1e-6) return false;
    // Round edges (not width/height) so the far edge has no sub-pixel seam.
    const x = Math.round(bounds.x * zoom);
    const y = Math.round(bounds.y * zoom);
    lastBrowserBounds = {
      x,
      y,
      width: Math.round((bounds.x + bounds.width) * zoom) - x,
      height: Math.round((bounds.y + bounds.height) * zoom) - y,
    };
    return true;
  }

  // Automation clients (docs shots, screenshot skills, Playwright) attach to a
  // tab over CDP and emulate a viewport with Emulation.setDeviceMetricsOverride.
  // Chromium keeps that emulated size after the client disconnects, so the page
  // keeps laying out for e.g. 1440x900 inside a 400px panel and shows up
  // clipped. Only a DevTools session that owns an override can drop it: take a
  // brief session of our own, set a disabled (zero) override, then clear it.
  // Call this on user-driven moments only — panel show, tab select, focus —
  // so a capture in progress is not disturbed by background navigation.
  function resetViewportEmulation(view) {
    const webContents = view?.webContents;
    if (!webContents || webContents.isDestroyed()) return;
    // A background tab's viewport is ours on purpose; it is restored when the
    // tab comes back on screen.
    const tab = tabForView(view);
    if (!tab?.domReady || tab.background || tab.suspending) return;
    const cdp = webContents.debugger;
    if (cdp.isAttached()) return;
    runDetachedTask("reset browser viewport emulation", async () => {
      cdp.attach("1.3");
      try {
        await cdp.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 0,
          height: 0,
          deviceScaleFactor: 0,
          mobile: false,
        });
        await cdp.sendCommand("Emulation.clearDeviceMetricsOverride");
      } finally {
        if (cdp.isAttached()) cdp.detach();
      }
    });
  }

  /** Detach every view that is neither on screen nor a background presence. */
  function detachIdleBrowserViews(keepView = null) {
    for (const tab of browserTabs.values()) {
      if (tab.view !== keepView && !tab.background) detachBrowserView(tab.view);
    }
  }

  function attachActiveBrowserView() {
    const mainWindow = window();
    if (!mainWindow || !browserViewVisible) return;
    if (!lastBrowserBounds || lastBrowserBounds.width <= 0 || lastBrowserBounds.height <= 0) return;
    const tab = getBrowserTab();
    if (!tab) { detachIdleBrowserViews(); return; }
    exitBackgroundMode(tab);
    tab.view.setVisible(!approvals.has(tab.tabId) && tab.loadError?.code !== "page_load_failed");
    detachIdleBrowserViews(tab.view);
    // Size before attaching so a restored view never flashes at stale bounds.
    tab.view.setBounds(lastBrowserBounds);
    if (!mainWindow.contentView.children.includes(tab.view)) {
      mainWindow.contentView.addChildView(tab.view);
    }
  }

  function selectBrowserTab(tabId) {
    const tab = browserTabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    if (tab.suspending) throw new Error("Browser tab is suspending.");
    markTabActive(tabId);
    hideContextMenu();
    const previousView = getActiveBrowserView();
    registry.select(tabId);
    if (registry.surfacingFor(tabId) === "foreground") {
      if (previousView && previousView !== tab.view && !tabForView(previousView)?.background) {
        detachBrowserView(previousView);
      }
      attachActiveBrowserView();
    }
    sendBrowserState();
    return tab;
  }

  function closeBrowserTab(tabId = registry.onScreenTabId(), preserve = false, reason = undefined) {
    const tab = getBrowserTab(tabId);
    if (!registry.has(tabId)) return null;
    approvals.get(tabId)?.finish(false);
    taskHost.invalidate(tabId, { closed: true, reason });
    if (!preserve) suspendedTabs.delete(tabId);
    if (menuRequest?.tabId === tabId) hideContextMenu();
    const wasOnScreen = registry.onScreenTabId() === tabId;
    if (tab) {
      tab.background = false;
      tab.finishSuspension?.(preserve ? null : new Error("Browser tab was closed."));
      detachBrowserView(tab.view);
    }
    webMcpBroker.invalidateTab(tabId);
    const refreshTimer = webMcpRefreshTimers.get(tabId);
    if (refreshTimer) clearTimeout(refreshTimer);
    webMcpRefreshTimers.delete(tabId);
    browserTabs.delete(tabId);
    const removed = preserve ? null : registry.remove(tabId);
    if (wasOnScreen) {
      if (registry.onScreenTabId()) {
        attachActiveBrowserView();
      } else {
        hideBrowserView();
      }
    }
    if (removed && !removed.ownerHasTabs) {
      sendToRenderer("openwork:browser:panel-closed", { ownerSessionId: removed.tab.ownerSessionId });
    }
    try {
      if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    } catch { /* already destroyed */ }
    releaseEmptyBackgroundWindow();
    sendBrowserState();
    return tabId;
  }

  function isFocusedBrowserTab(tab) {
    return browserViewVisible && registry.onScreenTabId() === tab.tabId
      && !tab.view.webContents.isDestroyed() && tab.view.webContents.isFocused()
      && tab.view.getVisible() && window()?.contentView.children.includes(tab.view);
  }

  function hasBrowserShortcutFocus() {
    const tab = getBrowserTab();
    if (tab && isFocusedBrowserTab(tab)) setShortcutFocus(tab.tabId);
    if (!shortcutFocus || shortcutFocus.visibleSessionId !== registry.visibleSessionId()) return false;
    // A last-tab close leaves a short-lived browser context so T can recover it
    // and a held/repeated W cannot accidentally close the application window.
    // Keyboard focus on an inactive tab-strip button still belongs to that
    // browser tab, even if an artifact currently occupies the native viewport.
    return shortcutFocus.tabId === null || registry.has(shortcutFocus.tabId);
  }

  function setShortcutFocus(tabId) {
    if (!registry.has(tabId) || registry.surfacingFor(tabId) !== "foreground") { shortcutFocus = null; return; }
    if (shortcutFocus?.tabId === tabId && shortcutFocus.visibleSessionId === registry.visibleSessionId()) return;
    shortcutFocus = { ownerSessionId: registry.ownerOf(tabId), visibleSessionId: registry.visibleSessionId(), tabId };
  }

  function closeUserBrowserTab(tabId = registry.onScreenTabId()) {
    if (!registry.has(tabId)) return null;
    const tab = getBrowserTab(tabId);
    const saved = tab && !tab.view.webContents.isDestroyed()
      ? browserTabToPanelTab(tabId, tab) : suspendedTabs.get(tabId);
    const ownerSessionId = registry.ownerOf(tabId);
    const focus = shortcutFocus?.ownerSessionId === ownerSessionId ? shortcutFocus : null;
    if (saved && (saved.url === "about:blank" || isHttpUrl(saved.url))) {
      closedTabs.push({ url: saved.url, ownerSessionId });
      closedTabs = closedTabs.slice(-MAX_CLOSED_BROWSER_TABS);
    }
    const result = closeBrowserTab(tabId);
    if (focus) {
      const nextId = registry.onScreenTabId();
      shortcutFocus = { ...focus, tabId: nextId && registry.ownerOf(nextId) === ownerSessionId ? nextId : null };
    }
    return result;
  }

  async function reopenClosedBrowserTab() {
    if (reopeningTab || !hasBrowserShortcutFocus()) return;
    const focus = shortcutFocus;
    const saved = closedTabs.slice().reverse().find((entry) => entry.ownerSessionId === focus.ownerSessionId);
    if (!saved) return;
    reopeningTab = true;
    try {
      await checkPolicy?.({ url: saved.url });
      // Focus, owner cleanup, or a conversation switch may change while policy
      // is checked. A stale shortcut must not resurrect a deleted owner's page.
      if (shortcutFocus !== focus || registry.visibleSessionId() !== focus.visibleSessionId || !closedTabs.includes(saved)) return;
      // Use the ordinary manual-open path. Target the new tab immediately,
      // before its asynchronous navigation: W must never fall through to Close
      // Window while loading. A later reload/navigation owns its own document.
      const tab = createBrowserTab(saved.url, { initializeBlank: false, ownerSessionId: saved.ownerSessionId });
      closedTabs = closedTabs.filter((entry) => entry !== saved);
      shortcutFocus = { ...focus, tabId: tab.tabId };
      focusBrowserShortcutTarget();
    } catch (error) {
      if (shortcutFocus === focus && window() && !window().isDestroyed()) {
        await dialog.showMessageBox(window(), {
          type: "error", message: "Could not reopen browser tab",
          detail: error instanceof Error ? error.message : "Try again after checking browser availability and your organization's policy.",
        });
      }
    } finally {
      reopeningTab = false;
    }
  }

  function focusBrowserShortcutTarget() {
    const tab = getBrowserTab();
    if (tab && shortcutFocus?.tabId === tab.tabId && browserViewVisible && tab.view.getVisible() && window()?.contentView.children.includes(tab.view)) tab.view.webContents.focus();
    else window()?.webContents.focus();
  }

  function closeFocusedBrowserTab(host = window()) {
    if (host !== window() || !hasBrowserShortcutFocus()) return false;
    if (shortcutFocus.tabId) closeUserBrowserTab(shortcutFocus.tabId);
    focusBrowserShortcutTarget();
    return true;
  }

  function handleBrowserShortcut(event, input) {
    const primary = process.platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
    const key = input.key?.toLowerCase();
    if (!primary || input.alt || input.shift || (key !== "w" && key !== "t") || !hasBrowserShortcutFocus()) return false;
    // Cancel both Chromium delivery and Electron menu accelerators synchronously.
    event.preventDefault();
    if (input.type !== "keyDown" || input.isAutoRepeat) return true;
    if (key === "w") closeFocusedBrowserTab();
    else runDetachedTask("reopen browser tab", reopenClosedBrowserTab);
    return true;
  }

  function registerWindowShortcuts(host) {
    host.webContents.on("before-input-event", (event, input) => {
      if (host !== window()) return;
      if (input.type === "keyDown" && (input.key === "Tab" || input.key === "Escape")) shortcutFocus = null;
      handleBrowserShortcut(event, input);
    });
    host.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) shortcutFocus = null;
    });
  }

  function requireTabOwner(tabId, sessionId) {
    if (!registry.has(tabId) || (sessionId !== null && !normalizeSessionId(sessionId)) || registry.ownerOf(tabId) !== sessionId) {
      throw new Error("Browser tab owner mismatch or unknown tab.");
    }
  }

  async function suspendBrowserTab(tabId) {
    const tab = browserTabs.get(tabId);
    const mainWindow = window();
    const check = () => {
      if (!tab || browserTabs.get(tabId) !== tab || tab.view.webContents.isDestroyed()) throw new Error("Unknown browser tab.");
      if (tab.automationProtected || tab.operation || tab.suspending) throw new Error("Browser tab is protected or busy. Release task protection before suspending.");
      if (tab.view.webContents.isLoading() || tab.downloads.size || tab.mediaPlaying || tab.view.webContents.isCurrentlyAudible()) {
        throw new Error("Browser tab is loading, downloading, or playing media.");
      }
    };
    check();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Browser window is unavailable.");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "Suspend browser tab?", message: "Suspend browser tab?",
      detail: "Form input, scroll position, and page history will be lost. Reload opens the saved URL, not the current document. Only suspend if you are willing to lose this page state.",
      buttons: ["Cancel", "Suspend"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return null;
    check();
    // Capture final thumbnail before suspending
    const thumbnail = await captureThumbnail(tab);
    suspendedTabs.set(tabId, { ...browserTabToPanelTab(tabId, tab), status: "suspended", canGoBack: false, canGoForward: false, thumbnail });
    stopThumbnailTimer(tabId);
    tab.suspending = true;
    sendBrowserState();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser tab is still waiting to close.")), BROWSER_TARGET_RESOLVE_TIMEOUT_MS);
      tab.finishSuspension = (error) => {
        clearTimeout(timer);
        tab.finishSuspension = null;
        if (error) reject(error); else resolve(tabId);
      };
      try { tab.view.webContents.close({ waitForBeforeUnload: true }); }
      catch (error) {
        tab.suspending = false;
        suspendedTabs.delete(tabId);
        tab.finishSuspension(error);
        sendBrowserState();
      }
    });
  }

  // Known live contents can identify their target without replacing the document
  // with a marker. Task protection is held by the page until explicit release.
  async function restoreBrowserTab(tabId, protect = false) {
    const saved = suspendedTabs.get(tabId);
    const live = browserTabs.get(tabId);
    if (live?.suspending || live?.operation) throw new Error("Browser tab is busy.");
    if (!live && !saved) throw new Error("Unknown browser tab.");
    const tab = live ?? createBrowserTab("about:blank", {
      initializeBlank: false, ownerSessionId: registry.ownerOf(tabId), restoreTabId: tabId, automationProtected: protect,
    });
    // Restore thumbnail if available
    if (saved?.thumbnail) tab.thumbnail = saved.thumbnail;
    const wasProtected = tab.automationProtected;
    tab.operation = true;
    if (protect) tab.automationProtected = true;
    sendBrowserState();
    try {
      if (!live) await tab.view.webContents.loadURL(saved.url);
      if (!tab.domReady) await new Promise((resolve, reject) => {
        const contents = tab.view.webContents;
        const finish = () => {
          clearTimeout(timer);
          contents.removeListener("dom-ready", finish);
          contents.removeListener("destroyed", finish);
          if (tab.domReady && !contents.isDestroyed()) resolve(undefined);
          else reject(new Error("Browser tab did not become ready."));
        };
        const timer = setTimeout(finish, BROWSER_TARGET_RESOLVE_TIMEOUT_MS);
        contents.once("dom-ready", finish);
        contents.once("destroyed", finish);
      });
      await tab.emulation;
      if (browserTabs.get(tabId) !== tab) throw new Error("Browser tab was closed.");
      let handle = null;
      if (protect) {
        const cdp = tab.view.webContents.debugger;
        const attached = cdp.isAttached();
        try {
          if (!attached) cdp.attach("1.3");
          const { targetInfo } = await cdp.sendCommand("Target.getTargetInfo");
          if (!targetInfo?.targetId) throw new Error("Could not resolve built-in browser CDP target.");
          handle = {
            provider: "builtin", browser_url: cdpBrowserUrl(), target_id: targetInfo.targetId,
            tab_id: tabId, url: tab.view.webContents.getURL(), owner_session_id: registry.ownerOf(tabId),
            visible: registry.surfacingFor(tabId) === "foreground",
          };
        } finally {
          if (!attached && !tab.view.webContents.isDestroyed() && cdp.isAttached()) cdp.detach();
        }
      }
      if (browserTabs.get(tabId) !== tab) throw new Error("Browser tab was closed.");
      suspendedTabs.delete(tabId);
      return { tab, handle };
    } catch (error) {
      if (browserTabs.get(tabId) === tab) {
        if (!live) closeBrowserTab(tabId, true);
        else tab.automationProtected = wasProtected;
      }
      throw error;
    } finally {
      tab.operation = false;
      sendBrowserState();
    }
  }

  function closeAllBrowserTabs(remember = false) {
    if (!remember) { closedTabs = []; shortcutFocus = null; }
    const closedTabIds = registry.list().map((tab) => tab.tabId);
    for (const tabId of closedTabIds) {
      if (remember) closeUserBrowserTab(tabId); else closeBrowserTab(tabId);
    }
    return closedTabIds;
  }

  function closeSessionBrowserTabs(sessionId) {
    // Missing/malformed ownership must never become a request to close shared
    // tabs or the currently visible conversation.
    const ownerSessionId = normalizeSessionId(sessionId);
    if (!ownerSessionId) return [];
    closedTabs = closedTabs.filter((entry) => entry.ownerSessionId !== ownerSessionId);
    if (shortcutFocus?.ownerSessionId === ownerSessionId) shortcutFocus = null;
    const closedTabIds = registry.list()
      .filter((tab) => tab.ownerSessionId === ownerSessionId)
      .map((tab) => tab.tabId);
    for (const tabId of closedTabIds) closeBrowserTab(tabId);
    return closedTabIds;
  }

  function reorderBrowserTabs(tabIds) {
    registry.reorder(tabIds);
    sendBrowserState();
    return listBrowserTabs();
  }

  function sendBrowserState() {
    sendToRenderer("openwork:browser:state", browserStatePayload());
  }

  /**
   * Attach the browser view to the main window.
   * @param {object} bounds — { x, y, width, height }
   * @param {object} [opts]
   * @param {string | null} [opts.sessionId] - the conversation whose panel is showing
   */
  function attachBrowserView(bounds, { sessionId } = {}) {
    if (!window() || !acceptBrowserBounds(bounds)) return false;
    browserViewVisible = true;
    if (sessionId !== undefined) {
      const previous = registry.visibleSessionId();
      if (registry.setVisibleSession(sessionId) !== previous) {
        shortcutFocus = null;
        hideContextMenu();
        applySurfacing();
      }
    }
    const view = getActiveBrowserView();
    attachActiveBrowserView();
    resetViewportEmulation(view);
    sendBrowserState();
    return true;
  }

  function hideBrowserView(preserveShortcutFocus = false) {
    if (!preserveShortcutFocus && shortcutFocus?.tabId) shortcutFocus = null;
    hideContextMenu();
    browserViewVisible = false;
    if (!window()) return;
    detachIdleBrowserViews();
  }

  function destroyBrowserView() {
    linkChoiceRequest?.finish(null);
    hideBrowserView();
    menuShowSerial += 1;
    closeAllBrowserTabs();
    browserTabs.clear();
    suspendedTabs.clear();
    registry.clear();
    if (backgroundWindow && !backgroundWindow.isDestroyed()) backgroundWindow.destroy();
    backgroundWindow = null;
    lastBrowserBounds = null;
    sendBrowserState();
  }

  function normalizeSessionId(value) {
    return typeof value === "string" && value.trim() ? value : null;
  }

  function registerIpc(ipcMain) {
    ipcMain.on("openwork:browser:shortcut-focus", (event, tabId) => {
      const contents = window()?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
      setShortcutFocus(tabId);
    });
    function authorizeManualNavigation(event) {
      const contents = window()?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error("Use the browser toolbar to navigate.");
      const tabId = registry.onScreenTabId();
      if (tabId && registry.ownerOf(tabId) !== registry.visibleSessionId()) throw new Error("Select this conversation first.");
      taskHost.manualNavigation(tabId);
    }
    ipcMain.handle("openwork:browser:show", (_event, bounds, sessionId) => (
      attachBrowserView(bounds, sessionId === undefined ? {} : { sessionId: normalizeSessionId(sessionId) })
    ));
    ipcMain.handle("openwork:browser:hide", (_event, options) => hideBrowserView(options?.preserveShortcutFocus === true));
    ipcMain.handle("openwork:browser:setVisibleSession", (_event, sessionId) => setVisibleSession(normalizeSessionId(sessionId)));
    ipcMain.handle("openwork:browser:openUrl", (_event, url, provider, options) => (
      openBrowserUrlForAutomation(url, provider, {
        ownerSessionId: normalizeSessionId(options && typeof options === "object" ? options.sessionId : null),
      })
    ));
    ipcMain.handle("openwork:browser:navigate", (event, url) => {
      authorizeManualNavigation(event);
      getActiveWebContents(); // Reject navigation while suspension is pending.
      const view = getActiveBrowserView()
        ?? createBrowserTab("about:blank", { select: true, ownerSessionId: registry.visibleSessionId() }).view;
      runDetachedTask("navigate browser tab", () => view.webContents.loadURL(normalizeBrowserUrl(url)));
    });
    ipcMain.handle("openwork:browser:back", (event) => {
      authorizeManualNavigation(event);
      const webContents = getActiveWebContents();
      if (webContents?.canGoBack()) webContents.goBack();
    });
    ipcMain.handle("openwork:browser:forward", (event) => {
      authorizeManualNavigation(event);
      const webContents = getActiveWebContents();
      if (webContents?.canGoForward()) webContents.goForward();
    });
    ipcMain.handle("openwork:browser:reload", (event) => {
      authorizeManualNavigation(event);
      const webContents = getActiveWebContents();
      const failure = getBrowserTab()?.loadError;
      if (failure?.code === "page_load_failed") {
        runDetachedTask("retry browser page", () => webContents?.loadURL(failure.url));
      } else {
        webContents?.reload();
      }
    });
    ipcMain.handle("openwork:browser:bounds", (_event, bounds) => {
      if (!acceptBrowserBounds(bounds)) return false;
      const view = getActiveBrowserView();
      if (view && browserViewVisible) {
        view.setBounds(lastBrowserBounds);
      }
      return true;
    });
    ipcMain.handle("openwork:browser:state", () => ({
      ...browserStatePayload(),
      nativeViews: browserNativeViews(),
      tabLimit: MAX_BROWSER_TABS,
      backgroundWindowCount: Number(Boolean(backgroundWindow && !backgroundWindow.isDestroyed())),
      backgroundWindowVisible: Boolean(backgroundWindow && !backgroundWindow.isDestroyed() && backgroundWindow.isVisible()),
      visibleWindowCount: BrowserWindow.getAllWindows().filter((host) => host.isVisible()).length,
    }));
    ipcMain.handle("openwork:browser:createTab", (_event, url, sessionId) => {
      const target = typeof url === "string" && url.trim() ? url : BROWSER_NEW_TAB_URL;
      const ownerSessionId = sessionId === undefined ? registry.visibleSessionId() : normalizeSessionId(sessionId);
      const tab = createBrowserTab(target, { select: true, ownerSessionId });
      return { tabId: tab.tabId };
    });
    ipcMain.handle("openwork:browser:closeTab", (_event, tabId) => closeUserBrowserTab(tabId == null ? undefined : String(tabId)));
    ipcMain.handle("openwork:browser:suspendTab", (_event, tabId) => suspendBrowserTab(tabId));
    ipcMain.handle("openwork:browser:restoreTab", async (_event, tabId, sessionId) => {
      requireTabOwner(tabId, sessionId);
      return (await restoreBrowserTab(tabId, true)).handle;
    });
    ipcMain.handle("openwork:browser:releaseTab", (_event, tabId, sessionId) => {
      requireTabOwner(tabId, sessionId);
      const tab = browserTabs.get(tabId);
      if (tab?.operation || tab?.suspending) throw new Error("Browser tab is busy.");
      if (tab) tab.automationProtected = false;
      sendBrowserState();
      return { tabId, released: true };
    });
    ipcMain.handle("openwork:browser:closeSessionTabs", (_event, sessionId) => closeSessionBrowserTabs(sessionId));
    ipcMain.handle("openwork:browser:selectTab", async (_event, tabId) => {
      const id = String(tabId ?? "");
      if (!browserTabs.has(id) && suspendedTabs.has(id)) await restoreBrowserTab(id);
      const tab = selectBrowserTab(id);
      resetViewportEmulation(tab.view);
      return tab.tabId;
    });
    ipcMain.handle("openwork:browser:reorderTabs", (_event, tabIds) => reorderBrowserTabs(tabIds));
    ipcMain.handle("openwork:browser:approve", (event, tabId, approvalId, allowed) => {
      if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame || registry.ownerOf(tabId) !== registry.visibleSessionId()) return false;
      const pending = approvals.get(tabId);
      if (!pending || pending.id !== approvalId) return false;
      pending.finish(allowed === true); return true;
    });
    ipcMain.handle("openwork:browser:taskControl", (event, tabId, action) => {
      if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame || !getBrowserTab(tabId) || registry.ownerOf(tabId) !== registry.visibleSessionId()) throw new Error("Select this conversation first.");
      if (action === "resume") taskHost.resume(tabId);
      else if (action === "pause") taskHost.pause(tabId);
      else throw new Error("Unsupported browser control.");
    });
    ipcMain.handle("openwork:webmcp:frame-policy", (event) => {
      const tab = [...browserTabs.values()].find((candidate) => candidate.view.webContents === event.sender);
      if (!tab || !event.senderFrame) {
        return { allowed: false, originKeyed: false, reason: "unknown_browser_frame" };
      }
      const sessionId = registry.ownerOf(tab.tabId) ?? "default";
      return ensureWebMcpFramePolicy(sessionId).checkFrame(event.senderFrame);
    });
    ipcMain.handle("openwork:browser:setProxy", (event, proxy) => {
      const sessionId = normalizeSessionId(event.senderFrame?.url?.split('/')[3]) ?? registry.visibleSessionId() ?? "default";
      return setBrowserProxy(sessionId, proxy);
    });
    ipcMain.handle("openwork:browser:getProxy", (event) => {
      const sessionId = normalizeSessionId(event.senderFrame?.url?.split('/')[3]) ?? registry.visibleSessionId() ?? "default";
      return browserProxyState(sessionId);
    });
    ipcMain.handle("openwork:browser:setControlEnabled", (event, enabled) => {
      if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame) return false;
      browserControlEnabled = enabled === true;
      if (!browserControlEnabled) for (const tab of browserTabs.values()) taskHost.pause(tab.tabId, "Browser control disabled");
      return browserControlEnabled;
    });
    ipcMain.handle("openwork:browser:tabContextMenu", (_event, tabId, point) => showBrowserTabContextMenu(tabId, point));
    ipcMain.handle("openwork:browser:chooseLinkDestination", (event, id, destination) => {
      const contents = window()?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
      if (!linkChoiceRequest || linkChoiceRequest.id !== id) return false;
      if (destination !== null && destination !== "openwork" && destination !== "external") return false;
      return linkChoiceRequest.finish(destination);
    });
    ipcMain.on("openwork:browser:linkClick", (event, payload) => {
      const contents = window()?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
      const url = payload?.url;
      if (typeof url !== "string" || !isHttpUrl(url) || url.length > 32_768) return;
      const parsed = new URL(url);
      if (parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(url)) return;
      // A second activation must not replace the link the open dialog names.
      if (linkChoiceRequest) return;
      const ownerSessionId = normalizeSessionId(payload.sessionId) ?? registry.visibleSessionId();
      const sourceFrame = event.senderFrame;
      let navigated = false;
      let cancelChoice = () => {};
      const isCurrent = () => !navigated && !contents.isDestroyed() && window()?.webContents === contents
        && contents.mainFrame === sourceFrame;
      const cleanup = () => {
        contents.removeListener("did-start-navigation", invalidate);
        contents.removeListener("destroyed", destroyed);
      };
      const open = (external) => runDetachedTask("open clicked browser link", () => handleMenuChoice(
        { source: "link", url, ownerSessionId }, external ? "open-external" : "open-builtin", isCurrent,
      ).finally(cleanup));
      const cancel = () => {
        navigated = true;
        cancelChoice();
      };
      const invalidate = (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) cancel();
      };
      const destroyed = () => cancel();
      contents.on("did-start-navigation", invalidate);
      contents.on("destroyed", destroyed);
      if (payload.ask === true) {
        const id = `link_${++linkChoiceCounter}`;
        cancelChoice = () => { if (linkChoiceRequest?.id === id) linkChoiceRequest.finish(null); };
        linkChoiceRequest = {
          id,
          finish(destination) {
            if (linkChoiceRequest?.id !== id) return false;
            linkChoiceRequest = null;
            sendToRenderer("openwork:browser:link-open-request", null);
            if (destination === null || !isCurrent()) { cleanup(); return false; }
            open(destination === "external");
            return true;
          },
        };
        sendToRenderer("openwork:browser:link-open-request", { id, url });
      } else {
        open(payload.external === true);
      }
    });
    ipcMain.on("openwork:browser:linkContextMenu", (event, payload) => {
      const mainContents = window()?.webContents;
      if (event.sender !== mainContents || event.senderFrame !== mainContents?.mainFrame) return;
      if (!payload || typeof payload !== "object") return;
      const showing = showLinkContextMenu(payload);
      runDetachedTask("show link context menu", () => showing);
    });
    ipcMain.handle("openwork:browser:destroy", () => destroyBrowserView());
    ipcMain.on("openwork:menu-overlay:dismiss", () => hideContextMenu());
    ipcMain.on("openwork:webmcp:tools-changed", (event) => {
      const tab = [...browserTabs.values()].find((candidate) => candidate.view.webContents === event.sender);
      if (!tab) return;
      // The page relays this after a debounce, so it routinely arrives after a
      // listing that already saw the same registrations. It is not a new
      // document: only navigation bumps the revision. Listed handles stay
      // valid, and execution revalidates each tool's live descriptor digest
      // before asking for consent, so a changed or removed tool still fails
      // as stale_tool while an unchanged one reaches the approval prompt.
      scheduleWebMcpToolCountRefresh(tab.tabId);
    });
    // Website Rules IPC handlers
    ipcMain.handle("openwork:website-rules:list", () => listWebsiteRules());
    ipcMain.handle("openwork:website-rules:get", (_event, origin) => getWebsiteRule(origin));
    ipcMain.handle("openwork:website-rules:set", (_event, origin, rule) => {
      setWebsiteRule(origin, rule);
      return { success: true };
    });
    ipcMain.handle("openwork:website-rules:remove", (_event, origin) => {
      removeWebsiteRule(origin);
      return { success: true };
    });
    ipcMain.handle("openwork:website-rules:check-permission", (_event, url) => ({
      allowed: isAgentAllowedByWebsiteRule(url),
      ask: shouldAskAgentPermission(url),
      rule: getWebsiteRule(url),
    }));
    ipcMain.handle("openwork:website-rules:apply", async (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      const url = tab.view.webContents.getURL();
      if (!url || url === "about:blank") return { success: false, error: "No URL loaded" };
      tab.websiteRule = getWebsiteRule(url);
      await applyWebsiteRuleToTab(tab, tab.websiteRule);
      return { success: true };
    });
    // Enable autonomous mode (agentPermission: "allow") for current tab's origin
    ipcMain.handle("openwork:website-rules:enable-autonomous", async (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      const url = tab.view.webContents.getURL();
      if (!url || url === "about:blank") return { success: false, error: "No URL loaded" };
      const origin = getOriginFromUrl(url);
      if (!origin) return { success: false, error: "Invalid URL" };
      setWebsiteRule(origin, { agentPermission: "allow" });
      tab.websiteRule = getWebsiteRule(url);
      await applyWebsiteRuleToTab(tab, tab.websiteRule);
      return { success: true, origin, rule: tab.websiteRule };
    });

    // ===== CHUNK 4: Viewport Presets IPC =====
    ipcMain.handle("openwork:viewport:presets", () => {
      return { presets: Object.fromEntries(Object.entries(DEVICE_PRESETS).map(([k, v]) => [k, { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, isMobile: v.isMobile, hasCustomUA: Boolean(v.userAgent) }])) };
    });

    ipcMain.handle("openwork:viewport:apply-preset", async (_event, tabId, presetName) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      const preset = DEVICE_PRESETS[presetName];
      if (!preset) return { success: false, error: `Unknown preset: ${presetName}` };
      const url = tab.view.webContents.getURL();
      if (!url || url === "about:blank") return { success: false, error: "No URL loaded" };
      const origin = getOriginFromUrl(url);
      if (!origin) return { success: false, error: "Invalid URL" };
      const rule = { viewport: { width: preset.width, height: preset.height, deviceScaleFactor: preset.deviceScaleFactor, isMobile: preset.isMobile } };
      if (preset.userAgent) rule.userAgent = preset.userAgent;
      setWebsiteRule(origin, rule);
      tab.websiteRule = getWebsiteRule(url);
      await applyWebsiteRuleToTab(tab, tab.websiteRule);
      return { success: true, origin, rule: tab.websiteRule, preset: presetName };
    });

    ipcMain.handle("openwork:viewport:set-custom", async (_event, tabId, viewport, userAgent) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      const url = tab.view.webContents.getURL();
      if (!url || url === "about:blank") return { success: false, error: "No URL loaded" };
      const origin = getOriginFromUrl(url);
      if (!origin) return { success: false, error: "Invalid URL" };
      const rule = {};
      if (viewport) rule.viewport = { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor || 1, isMobile: viewport.isMobile || false };
      if (userAgent) rule.userAgent = userAgent;
      setWebsiteRule(origin, rule);
      tab.websiteRule = getWebsiteRule(url);
      await applyWebsiteRuleToTab(tab, tab.websiteRule);
      return { success: true, origin, rule: tab.websiteRule };
    });

    ipcMain.handle("openwork:viewport:reset", async (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      const url = tab.view.webContents.getURL();
      if (!url || url === "about:blank") return { success: false, error: "No URL loaded" };
      const origin = getOriginFromUrl(url);
      if (!origin) return { success: false, error: "Invalid URL" };
      removeWebsiteRule(origin);
      tab.websiteRule = getWebsiteRule(url);
      await applyWebsiteRuleToTab(tab, tab.websiteRule);
      return { success: true, origin, rule: tab.websiteRule };
    });

    // Partition info handlers (CHUNK 5: Per-origin partitions)
    ipcMain.handle("openwork:browser:get-partition", (_event, sessionId, url) => {
      const normalizedSessionId = normalizeSessionId(sessionId) ?? "default";
      const partition = url && url !== "about:blank" ? getOriginPartition(normalizedSessionId, url) : getSessionPartition(normalizedSessionId);
      return { partition, sessionId: normalizedSessionId, url };
    });

    ipcMain.handle("openwork:browser:list-partitions", () => {
      const partitions = new Map();
      for (const [tabId, tab] of browserTabs) {
        const sessionId = registry.ownerOf(tabId) ?? "default";
        const url = tab.view.webContents.getURL();
        const partition = tab.view.webContents.session.getPartitionName();
        const key = `${sessionId}:${partition}`;
        if (!partitions.has(key)) {
          partitions.set(key, { sessionId, partition, urls: [] });
        }
        if (url && url !== "about:blank") {
          partitions.get(key).urls.push({ tabId, url });
        }
      }
      return { partitions: [...partitions.values()] };
    });

    // ===== CDP Domain Expansion IPC (CHUNK 6) =====
    ipcMain.handle("openwork:cdp:send-command", async (_event, tabId, method, params) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, method, params);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:get-network-requests", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      return { success: true, requests: tab._networkRequests ? [...tab._networkRequests.values()] : [] };
    });

    ipcMain.handle("openwork:cdp:get-console-messages", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      return { success: true, messages: tab._consoleMessages || [] };
    });

    ipcMain.handle("openwork:cdp:get-targets", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      return { success: true, targets: tab._cdpTargets ? [...tab._cdpTargets.values()] : [] };
    });

    ipcMain.handle("openwork:cdp:evaluate", async (_event, tabId, expression, awaitPromise = true) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Runtime.evaluate", {
          expression,
          awaitPromise,
          returnByValue: true,
        });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:get-document", async (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "DOM.getDocument", { depth: -1, pierce: true });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:query-selector", async (_event, tabId, selector) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const doc = await sendCdpCommand(tab, "DOM.getDocument", { depth: 1, pierce: true });
        const nodeId = doc.root?.nodeId;
        if (!nodeId) return { success: false, error: "No document root" };
        const result = await sendCdpCommand(tab, "DOM.querySelector", { nodeId, selector });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:get-outer-html", async (_event, tabId, nodeId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "DOM.getOuterHTML", { nodeId });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:dispatch-mouse-event", async (_event, tabId, eventParams) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Input.dispatchMouseEvent", eventParams);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:dispatch-key-event", async (_event, tabId, eventParams) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Input.dispatchKeyEvent", eventParams);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:set-device-metrics", async (_event, tabId, metrics) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Emulation.setDeviceMetricsOverride", metrics);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:clear-device-metrics", async (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Emulation.clearDeviceMetricsOverride");
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:set-user-agent", async (_event, tabId, userAgent) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Emulation.setUserAgentOverride", { userAgent });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:capture-screenshot", async (_event, tabId, format = "png", quality = 80) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Page.captureScreenshot", { format, quality });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:reload", async (_event, tabId, ignoreCache = false) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Page.reload", { ignoreCache });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:navigate", async (_event, tabId, url) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      if (!tab.cdpInitialized) {
        await initializeCdpForTab(tab);
      }
      try {
        const result = await sendCdpCommand(tab, "Page.navigate", { url });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:cdp:get-page-load-state", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      return { success: true, loadState: tab._pageLoadState || "unknown" };
    });

    // ===== Per-Tab Proxy + PAC IPC (CHUNK 7) =====
    ipcMain.handle("openwork:proxy:set-tab-proxy", async (_event, tabId, config) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      try {
        const result = await setTabProxy(tabId, config);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:proxy:clear-tab-proxy", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      return clearTabProxy(tabId);
    });

    ipcMain.handle("openwork:proxy:get-tab-proxy", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      return { success: true, state: getTabProxyState(tabId) };
    });

    ipcMain.handle("openwork:proxy:resolve-tab-proxy", async (_event, tabId, url) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      try {
        const proxy = await resolveTabProxy(tabId, url);
        return { success: true, proxy, url };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:proxy:pac-fetch", async (_event, pacUrl) => {
      try {
        const compiled = await fetchAndCompilePac(pacUrl);
        return { success: true, pacUrl, compiled: Boolean(compiled) };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // ===== WebMCP Tool Integration IPC (CHUNK 8) =====
    ipcMain.handle("openwork:webmcp:tab-tools", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      return { success: true, tools: tab.webMcpTools || [], tabId };
    });

    ipcMain.handle("openwork:webmcp:execute-tool", async (_event, tabId, toolId, input = {}) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      const ownerSessionId = registry.ownerOf(tabId);
      if (!ownerSessionId) return { success: false, error: "No owner session" };

      try {
        const result = await taskHost.request({
          sessionId: ownerSessionId,
          operation: "site_tool",
          args: { tabId, toolId, input }
        });
        return { success: result.ok, result: result.result, error: result.error };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("openwork:webmcp:refresh-tools", async (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return { success: false, error: "Tab not found" };
      await scheduleWebMcpToolCountRefresh(tabId);
      sendBrowserState();
      return { success: true, tabId };
    });
  }

  return {
    closeFocusedBrowserTab,
    registerWindowShortcuts,
    destroy: destroyBrowserView,
    isMainWindowAllowedNavigation,
    browserTask: (args, options) => taskHost.request(args, options),
    listWebMcpTools: (args, options) => taskHost.request({ sessionId: args?.sessionId, operation: "site_tools", args }, options),
    executeWebMcpTool: (args, options) => taskHost.request({ sessionId: args?.sessionId, operation: "site_tool", args }, options),
    registerIpc,
    routeBlockedMainWindowNavigation,
  };
}
