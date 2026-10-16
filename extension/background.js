importScripts("presets.js");

// Storage ownership: the popup writes CONFIG_KEY, this worker writes SESSION_KEY.
// Keeping the two objects separate means neither side can overwrite the other's fields.
const CONFIG_KEY = "openfoxy.config";
const SESSION_KEY = "openfoxy.session";

const SESSION_SAVE_DELAY_MS = 500;
const IP_LOOKUP_TIMEOUT_MS = 8000;
const REQUEST_OVERHEAD_BYTES = 200;

// Only these settings influence the proxy or the DNR rules. Changing any other setting
// (theme, fingerprint toggles, ...) must not reconnect the active profile.
const CONNECTION_SETTING_KEYS = [
  "killSwitch",
  "blockTrackers",
  "dnt",
  "gpc",
  "stripReferrer",
  "clientHints",
];

// Anchored declarativeNetRequest filters: `||` anchors to a domain (and its subdomains),
// `^` is a separator so `||facebook.com/tr^` matches /tr and /tr/?x but not /track.
const TRACKER_FILTERS = [
  "||doubleclick.net^",
  "||google-analytics.com^",
  "||googletagmanager.com^",
  "||facebook.net^",
  "||facebook.com/tr^",
  "||hotjar.com^",
  "||segment.io^",
  "||mixpanel.com^",
  "||scorecardresearch.com^",
  "||adnxs.com^",
  "||taboola.com^",
  "||outbrain.com^",
];

// Dynamic rule IDs are fixed and bounded: one header rule followed by one rule per tracker.
const HEADER_RULE_ID = 1000;
const TRACKER_RULE_ID_BASE = 1001;
const DNR_RULE_IDS = Array.from(
  { length: 1 + TRACKER_FILTERS.length },
  (_, i) => HEADER_RULE_ID + i,
);
const DNR_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "script",
  "image",
  "xmlhttprequest",
  "media",
  "font",
  "stylesheet",
  "other",
];

const AUTHENTICATED_SOCKS5_ERROR =
  "Chrome extensions cannot authenticate SOCKS5 proxies. Use an HTTP/residential profile, unauthenticated SOCKS5, or a local HTTP-to-SOCKS bridge.";

let activeProfile = null;
let activeSettings = {};
let connected = false;
let connectionError = "";
let stats = { upload: 0, download: 0 };
let proxyIp = null;
let sessionSaveTimer = null;
// Incremented by every connect/disconnect so a slower, older request can detect it was superseded.
let connectionSeq = 0;

function hasProxyCredentials(profile) {
  return !!(String(profile?.user || "").trim() || String(profile?.pass || "").trim());
}

function unsupportedAuthenticatedSocks5(profile) {
  return profile?.protocol === "socks5" && hasProxyCredentials(profile);
}

function proxyAuthSupported(profile) {
  return profile?.protocol === "http" || profile?.protocol === "residential";
}

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function proxyChallengeMatches(details, profile) {
  if (!details?.challenger) return true;
  return (
    normalizeHost(profile?.host) === normalizeHost(details.challenger.host) &&
    Number(profile?.port) === Number(details.challenger.port)
  );
}

// Credentials are only ever offered to the active proxy itself, never to origin servers.
function proxyAuthCredentialsFor(details) {
  if (
    !details?.isProxy ||
    !connected ||
    !activeProfile ||
    !proxyAuthSupported(activeProfile) ||
    !hasProxyCredentials(activeProfile) ||
    !proxyChallengeMatches(details, activeProfile)
  ) {
    return null;
  }
  return {
    username: String(activeProfile.user || "").trim(),
    password: String(activeProfile.pass || ""),
  };
}

function pacScheme(protocol) {
  return protocol === "socks5" ? "SOCKS5" : "PROXY";
}

function proxyAddress(profile) {
  const host = String(profile.host || "").trim();
  const port = Number(profile.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return "DIRECT";
  return `${pacScheme(profile.protocol)} ${host}:${port}`;
}

function normalizePattern(pattern) {
  let value = String(pattern || "").trim();
  if (!value || value.startsWith("#")) return null;
  value = value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (value.startsWith("*.")) value = value.slice(2);
  return value.toLowerCase();
}

function parsePatterns(patterns) {
  return String(patterns || "")
    .split(/\n+/)
    .map(normalizePattern)
    .filter(Boolean);
}

function buildPacScript(profile, settings = {}) {
  if (profile.activation === "pac") {
    if (String(profile.pacBody || "").trim()) return profile.pacBody;
    return `function FindProxyForURL(url, host) { return "DIRECT"; }`;
  }

  // With the kill switch, traffic that should not use the proxy is sent to a dead port
  // instead of silently leaking out directly.
  const fallback = settings.killSwitch ? "PROXY 127.0.0.1:9" : "DIRECT";
  let proxy = proxyAddress(profile);
  if (proxy === "DIRECT") proxy = fallback;
  const patterns = JSON.stringify(parsePatterns(profile.patterns));
  const activation = profile.activation || "all";

  return `function FindProxyForURL(url, host) {
  host = String(host || "").toLowerCase();
  var proxy = ${JSON.stringify(proxy)};
  var fallback = ${JSON.stringify(fallback)};
  var patterns = ${patterns};
  function matches(h, p) { return h === p || h.endsWith("." + p) || shExpMatch(h, p); }
  if (isPlainHostName(host) || dnsDomainIs(host, ".local")) return "DIRECT";
  if (${JSON.stringify(activation)} === "all") return proxy;
  var hit = false;
  for (var i = 0; i < patterns.length; i++) { if (matches(host, patterns[i])) { hit = true; break; } }
  if (${JSON.stringify(activation)} === "include") return hit ? proxy : fallback;
  if (${JSON.stringify(activation)} === "exclude") return hit ? fallback : proxy;
  return fallback;
}`;
}

function buildProxyConfig(profile, settings = {}) {
  if (!profile) return { mode: "direct" };
  const mandatory = !!settings.killSwitch;
  if (profile.activation === "pac" && String(profile.pacUrl || "").trim()) {
    return { mode: "pac_script", pacScript: { url: profile.pacUrl.trim(), mandatory } };
  }
  return { mode: "pac_script", pacScript: { data: buildPacScript(profile, settings), mandatory } };
}

function languageHeader(profile) {
  const language = String(profile?.language || "").trim();
  if (!language) return null;
  if (language.includes(";")) return language;
  const base = language.split("-")[0];
  return base && base !== language ? `${language},${base};q=0.9` : language;
}

// Derives Sec-CH-UA-Mobile / Sec-CH-UA-Platform values from the User-Agent string itself,
// so presets and custom User-Agents are handled the same way.
function clientHintsFor(userAgent) {
  const platforms = [
    [/iPhone|iPad/, "iOS"],
    [/Android/, "Android"],
    [/Windows/, "Windows"],
    [/Macintosh/, "macOS"],
    [/Linux|X11/, "Linux"],
  ];
  const platform = platforms.find(([pattern]) => pattern.test(userAgent))?.[1];
  return { mobile: /\bMobile\b/.test(userAgent) ? "?1" : "?0", platform };
}

function buildRequestHeaders(profile, settings) {
  const headers = [];
  const set = (header, value) => headers.push({ header, operation: "set", value });
  const userAgent = globalThis.OpenFoxyPresets.resolveUserAgent(profile);
  const language = languageHeader(profile);

  if (userAgent) set("User-Agent", userAgent);
  if (language) set("Accept-Language", language);
  if (settings.dnt) set("DNT", "1");
  if (settings.gpc) set("Sec-GPC", "1");
  if (settings.clientHints && userAgent) {
    const { mobile, platform } = clientHintsFor(userAgent);
    set("Sec-CH-UA-Mobile", mobile);
    if (platform) set("Sec-CH-UA-Platform", JSON.stringify(platform));
  }
  if (settings.stripReferrer) headers.push({ header: "Referer", operation: "remove" });
  return headers;
}

// Pure: returns the declarativeNetRequest dynamic rules for a profile and settings.
// MV3 cannot rewrite headers via webRequest, so DNR is the only place this can happen.
function buildDynamicRules(profile, settings = {}) {
  const rules = [];
  const requestHeaders = buildRequestHeaders(profile, settings);
  if (requestHeaders.length) {
    rules.push({
      id: HEADER_RULE_ID,
      priority: 2,
      action: { type: "modifyHeaders", requestHeaders },
      condition: { urlFilter: "|http", resourceTypes: DNR_RESOURCE_TYPES },
    });
  }
  if (settings.blockTrackers) {
    TRACKER_FILTERS.forEach((urlFilter, index) => {
      rules.push({
        id: TRACKER_RULE_ID_BASE + index,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter, resourceTypes: DNR_RESOURCE_TYPES },
      });
    });
  }
  return rules;
}

async function updateDeclarativeRules(profile, settings = {}) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: DNR_RULE_IDS,
    addRules: buildDynamicRules(profile, settings),
  });
}

function actionIconPaths(theme) {
  const prefix = theme === "dark" ? "icons/dark/" : "icons/";
  return {
    16: `${prefix}icon16.png`,
    32: `${prefix}icon32.png`,
    48: `${prefix}icon48.png`,
    128: `${prefix}icon128.png`,
  };
}

async function updateActionIcon(theme) {
  await chrome.action.setIcon({ path: actionIconPaths(theme) });
}

async function refreshProxyIp() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IP_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`https://icanhazip.com/?openfoxy=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const text = (await response.text()).trim();
    proxyIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) ? text : null;
  } catch (error) {
    // The exit IP is informational only; a failed lookup must not fail the connection.
    console.warn("OpenFoxy exit IP lookup failed", error);
    proxyIp = null;
  } finally {
    clearTimeout(timeout);
  }
  scheduleSessionSave();
  return proxyIp;
}

async function saveSession() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;
  await chrome.storage.local.set({
    [SESSION_KEY]: { connected, stats, proxyIp, connectionError },
  });
}

// Traffic counters change on every request, so they are persisted in batches.
function scheduleSessionSave() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    saveSession().catch((error) => console.warn("OpenFoxy failed to persist session", error));
  }, SESSION_SAVE_DELAY_MS);
}

function chromeCallbackToPromise(invoke) {
  return new Promise((resolve, reject) => {
    invoke(() => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function setProxyConfig(config) {
  return chromeCallbackToPromise((done) =>
    chrome.proxy.settings.set({ scope: "regular", value: config }, done),
  );
}

function clearProxyConfig() {
  return chromeCallbackToPromise((done) => chrome.proxy.settings.clear({ scope: "regular" }, done));
}

async function resetConnectionState(error = "") {
  activeProfile = null;
  activeSettings = {};
  connected = false;
  connectionError = error;
  stats = { upload: 0, download: 0 };
  proxyIp = null;
  await clearProxyConfig();
  await updateDeclarativeRules(null, {});
  await saveSession();
}

// `keepStats` is used when resuming after the worker was suspended: Chrome keeps the proxy
// settings, so only the in-memory state needs rebuilding and counters should survive.
async function connectProfile(profile, settings = {}, { keepStats = false } = {}) {
  const seq = ++connectionSeq;
  if (unsupportedAuthenticatedSocks5(profile)) {
    await resetConnectionState(AUTHENTICATED_SOCKS5_ERROR);
    return { ok: false, error: AUTHENTICATED_SOCKS5_ERROR };
  }
  try {
    await setProxyConfig(buildProxyConfig(profile, settings));
    await updateDeclarativeRules(profile, settings);
    if (seq !== connectionSeq) return { ok: false, error: "connection superseded" };

    activeProfile = profile;
    activeSettings = settings;
    connected = true;
    connectionError = "";
    if (!keepStats) {
      stats = { upload: 0, download: 0 };
      proxyIp = null;
    }
    await saveSession();

    if (!keepStats || !proxyIp) await refreshProxyIp();
    if (seq !== connectionSeq) return { ok: false, error: "connection superseded" };
    return { ok: true, proxyIp };
  } catch (error) {
    const message = error.message || "failed to configure proxy";
    if (seq === connectionSeq) await resetConnectionState(message);
    return { ok: false, error: message };
  }
}

async function disconnectProfile() {
  connectionSeq++;
  await resetConnectionState();
  return { ok: true };
}

async function readStorage() {
  const data = await chrome.storage.local.get([CONFIG_KEY, SESSION_KEY]);
  return { config: data[CONFIG_KEY] || {}, session: data[SESSION_KEY] || {} };
}

function selectedProfile(config) {
  return Array.isArray(config.profiles)
    ? config.profiles.find((profile) => profile.id === config.activeId)
    : undefined;
}

function connectionSettings(settings) {
  return JSON.stringify(CONNECTION_SETTING_KEYS.map((key) => settings?.[key] ?? null));
}

async function restoreState() {
  const { config, session } = await readStorage();
  stats = session.stats || stats;
  proxyIp = session.proxyIp || null;
  await updateActionIcon(config.actionIconTheme || "light");

  const profile = selectedProfile(config);
  if (profile && (session.connected || config.settings?.autoConnect)) {
    await connectProfile(profile, config.settings || {}, { keepStats: !!session.connected });
  } else {
    await clearProxyConfig();
    if (session.connected) await resetConnectionState();
  }
}

// Called by the popup after it saved the config. Reconnects only if the active profile or a
// connection-relevant setting actually changed, so merely opening the popup is side-effect free.
async function applyStoredConfig() {
  const { config } = await readStorage();
  await updateActionIcon(config.actionIconTheme || "light");
  if (!connected) return { ok: true };

  const profile = selectedProfile(config);
  if (!profile) return disconnectProfile();
  const settings = config.settings || {};
  const unchanged =
    JSON.stringify(profile) === JSON.stringify(activeProfile) &&
    connectionSettings(settings) === connectionSettings(activeSettings);
  return unchanged ? { ok: true } : connectProfile(profile, settings);
}

// Listeners must be registered synchronously at worker startup.
// Restoring on every worker start also covers the browser-launch and install events;
// those listeners only exist so Chrome wakes the worker for them.
const ready = restoreState().catch((error) => console.warn("OpenFoxy restore failed", error));
chrome.runtime.onInstalled.addListener(() => ready);
chrome.runtime.onStartup.addListener(() => ready);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (message.type) {
      case "connect":
        return connectProfile(message.profile, message.settings || {});
      case "disconnect":
        return disconnectProfile();
      case "getState":
        return { connected, profile: activeProfile, stats, proxyIp, connectionError };
      case "getStats":
        return { stats, proxyIp };
      case "setActionIconTheme":
        await updateActionIcon(message.theme === "dark" ? "dark" : "light");
        return { ok: true };
      case "stateChanged":
        return applyStoredConfig();
      default:
        return { ok: false, error: "unknown message" };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    const authCredentials = proxyAuthCredentialsFor(details);
    callback(authCredentials ? { authCredentials } : { cancel: false });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!connected || !activeProfile) return;
    let size = REQUEST_OVERHEAD_BYTES;
    for (const item of details.requestBody?.raw || []) size += item.bytes?.byteLength || 0;
    stats.upload += size;
    scheduleSessionSave();
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!connected || !activeProfile) return;
    let size = REQUEST_OVERHEAD_BYTES;
    for (const header of details.responseHeaders || []) {
      if (header.name.toLowerCase() === "content-length") size += Number(header.value) || 0;
    }
    stats.download += size;
    scheduleSessionSave();
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.proxy.onProxyError.addListener((details) => console.warn("OpenFoxy proxy error", details));
