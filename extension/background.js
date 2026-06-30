const STORE_KEY = "openfoxy.v2";

let activeProfile = null;
let activeSettings = {};
let connected = false;
let stats = { upload: 0, download: 0 };
let proxyIp = null;
let authListenerInstalled = false;
let saveTimer = null;
let connectionSeq = 0;

const TRACKER_HOSTS = [
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "facebook.com/tr",
  "hotjar.com",
  "segment.io",
  "mixpanel.com",
  "scorecardresearch.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
];
const DNR_RULE_IDS = Array.from({ length: TRACKER_HOSTS.length + 8 }, (_, i) => i + 1000);
const AUTHENTICATED_SOCKS5_ERROR =
  "Chrome extensions cannot authenticate SOCKS5 proxies. Use an HTTP/residential profile, unauthenticated SOCKS5, or a local HTTP-to-SOCKS bridge.";

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
  const expectedHost = normalizeHost(profile?.host);
  const challengeHost = normalizeHost(details.challenger.host);
  const expectedPort = Number(profile?.port);
  const challengePort = Number(details.challenger.port);
  return expectedHost === challengeHost && expectedPort === challengePort;
}

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

function normalizeProtocol(protocol) {
  return protocol === "socks5" ? "SOCKS5" : "PROXY";
}

function proxyAddress(profile) {
  const host = String(profile.host || "").trim();
  const port = Number(profile.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return "DIRECT";
  return `${normalizeProtocol(profile.protocol)} ${host}:${port}`;
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

  let proxy = proxyAddress(profile);
  const fallback = settings.killSwitch ? "PROXY 127.0.0.1:9" : "DIRECT";
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
  if (profile.activation === "pac" && String(profile.pacUrl || "").trim()) {
    return {
      mode: "pac_script",
      pacScript: { url: profile.pacUrl.trim(), mandatory: !!settings.killSwitch },
    };
  }
  return {
    mode: "pac_script",
    pacScript: { data: buildPacScript(profile, settings), mandatory: !!settings.killSwitch },
  };
}

function actionIconPaths(theme = "light") {
  const prefix = theme === "dark" ? "icons/dark/" : "icons/";
  return {
    16: `${prefix}icon16.png`,
    32: `${prefix}icon32.png`,
    48: `${prefix}icon48.png`,
    128: `${prefix}icon128.png`,
  };
}

async function updateActionIcon(theme) {
  if (typeof chrome === "undefined" || !chrome.action?.setIcon) return;
  await chrome.action.setIcon({ path: actionIconPaths(theme) });
}

async function refreshProxyIp() {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    const response = await fetch(`https://icanhazip.com/?openfoxy=${Date.now()}`, {
      cache: "no-store",
      signal: controller?.signal,
    });
    const text = (await response.text()).trim();
    proxyIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) ? text : null;
  } catch {
    proxyIp = null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  scheduleStatsSave();
  return proxyIp;
}

function presetUserAgent(profile) {
  if (profile?.uaCustom) return profile.uaCustom;
  if (!profile?.uaId || profile.uaId === "current") return undefined;
  const presets = {
    "chrome-win":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "chrome-mac":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "safari-mac":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "firefox-win":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    android:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  };
  return presets[profile?.uaId] || null;
}

function languageHeader(profile) {
  const language = String(profile?.language || "").trim();
  if (!language) return null;
  if (language.includes(";")) return language;
  const base = language.split("-")[0];
  return base && base !== language ? `${language},${base};q=0.9` : language;
}

function setHeader(headers, name, value) {
  const idx = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
  if (value === undefined) return;
  if (value === null || value === "") {
    if (idx >= 0) headers.splice(idx, 1);
    return;
  }
  if (idx >= 0) headers[idx].value = value;
  else headers.push({ name, value });
}

async function updateDeclarativeRules(profile, settings = {}) {
  if (typeof chrome === "undefined" || !chrome.declarativeNetRequest?.updateDynamicRules) return;
  const addRules = [];
  let id = DNR_RULE_IDS[0];
  if (settings.blockTrackers) {
    for (const tracker of TRACKER_HOSTS) {
      addRules.push({
        id: id++,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: tracker,
          resourceTypes: [
            "main_frame",
            "sub_frame",
            "script",
            "image",
            "xmlhttprequest",
            "media",
            "font",
            "stylesheet",
            "other",
          ],
        },
      });
    }
  }
  const requestHeaders = [];
  const ua = presetUserAgent(profile);
  const language = languageHeader(profile);
  if (ua) requestHeaders.push({ header: "User-Agent", operation: "set", value: ua });
  if (language)
    requestHeaders.push({ header: "Accept-Language", operation: "set", value: language });
  if (settings.dnt) requestHeaders.push({ header: "DNT", operation: "set", value: "1" });
  if (settings.gpc) requestHeaders.push({ header: "Sec-GPC", operation: "set", value: "1" });
  if (settings.referrer === "no-referrer")
    requestHeaders.push({ header: "Referer", operation: "remove" });
  if (requestHeaders.length) {
    addRules.push({
      id: id++,
      priority: 2,
      action: { type: "modifyHeaders", requestHeaders },
      condition: {
        urlFilter: "|http",
        resourceTypes: [
          "main_frame",
          "sub_frame",
          "script",
          "image",
          "xmlhttprequest",
          "media",
          "font",
          "stylesheet",
          "other",
        ],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: DNR_RULE_IDS, addRules });
}

function applyPrivacyHeaders(headers, profile, settings, url) {
  const next = [...(headers || [])];
  setHeader(next, "User-Agent", presetUserAgent(profile));
  setHeader(next, "Accept-Language", languageHeader(profile));
  setHeader(next, "DNT", settings.dnt ? "1" : null);
  setHeader(next, "Sec-GPC", settings.gpc ? "1" : null);
  if (settings.referrer === "no-referrer") setHeader(next, "Referer", null);
  if (settings.referrer === "origin") {
    try {
      const ref = next.find((h) => h.name.toLowerCase() === "referer");
      if (ref?.value) ref.value = new URL(ref.value).origin + "/";
    } catch {}
  }
  if (settings.clientHints && presetUserAgent(profile)) {
    const mobile = /iphone|android/i.test(presetUserAgent(profile)) ? "?1" : "?0";
    setHeader(next, "Sec-CH-UA-Mobile", mobile);
    setHeader(next, "Sec-CH-UA-Platform", JSON.stringify(profile.platform || "Windows"));
  }
  return next;
}

function isTrackerUrl(url) {
  let value;
  try {
    value = new URL(url);
  } catch {
    return false;
  }
  const host = value.hostname.toLowerCase();
  const full = `${host}${value.pathname}`.toLowerCase();
  return TRACKER_HOSTS.some(
    (tracker) => full === tracker || full.includes(tracker) || host.endsWith(`.${tracker}`),
  );
}

function installAuthHandler() {
  if (authListenerInstalled || typeof chrome === "undefined") return;
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      const authCredentials = proxyAuthCredentialsFor(details);
      if (authCredentials) {
        callback({ authCredentials });
        return;
      }
      callback({ cancel: false });
    },
    { urls: ["<all_urls>"] },
    ["asyncBlocking"],
  );
  authListenerInstalled = true;
}

function scheduleStatsSave() {
  if (saveTimer || typeof chrome === "undefined") return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const data = await chrome.storage.local.get(STORE_KEY);
      const store = data[STORE_KEY] || {};
      await chrome.storage.local.set({ [STORE_KEY]: { ...store, connected, stats, proxyIp } });
    } catch (error) {
      console.warn("OpenFoxy failed to persist state", error);
    }
  }, 500);
}

function setProxyConfig(config) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ scope: "regular", value: config }, () => {
      const error = chrome.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function clearProxyConfig() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      const error = chrome.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function resetConnectionState() {
  activeProfile = null;
  activeSettings = {};
  connected = false;
  stats = { upload: 0, download: 0 };
  proxyIp = null;
  await clearProxyConfig();
  await updateDeclarativeRules(null, {});
  scheduleStatsSave();
}

async function connectProfile(profile, settings = {}) {
  const seq = ++connectionSeq;
  if (unsupportedAuthenticatedSocks5(profile)) {
    await resetConnectionState();
    return { ok: false, error: AUTHENTICATED_SOCKS5_ERROR };
  }
  try {
    stats = { upload: 0, download: 0 };
    proxyIp = null;
    installAuthHandler();
    await setProxyConfig(buildProxyConfig(profile, settings));
    await updateDeclarativeRules(profile, settings);
    if (seq !== connectionSeq) return { ok: false, error: "connection superseded" };
    activeProfile = profile;
    activeSettings = settings;
    connected = true;
    scheduleStatsSave();
    const refreshedIp = await refreshProxyIp();
    if (seq !== connectionSeq) return { ok: false, error: "connection superseded" };
    return { ok: true, proxyIp: refreshedIp };
  } catch (error) {
    if (seq === connectionSeq) await resetConnectionState();
    return { ok: false, error: error.message || "failed to configure proxy" };
  }
}

async function disconnectProfile() {
  connectionSeq++;
  await resetConnectionState();
  return { ok: true };
}

async function restoreState() {
  const data = await chrome.storage.local.get(STORE_KEY);
  const store = data[STORE_KEY] || {};
  stats = store.stats || stats;
  proxyIp = store.proxyIp || null;
  await updateActionIcon(store.actionIconTheme || "light");
  if (
    (store.connected || store.settings?.autoConnect) &&
    store.activeId &&
    Array.isArray(store.profiles)
  ) {
    const profile = store.profiles.find((p) => p.id === store.activeId);
    if (profile) await connectProfile(profile, store.settings || {});
  } else {
    await clearProxyConfig();
  }
}

async function reapplyStoredState() {
  const data = await chrome.storage.local.get(STORE_KEY);
  const store = data[STORE_KEY] || {};
  await updateActionIcon(store.actionIconTheme || "light");
  if (!connected || !store.activeId || !Array.isArray(store.profiles)) return { ok: true };
  const profile = store.profiles.find((p) => p.id === store.activeId);
  return profile ? connectProfile(profile, store.settings || {}) : disconnectProfile();
}

if (typeof globalThis !== "undefined") {
  globalThis.openFoxyTestApi = {
    connectProfile,
    disconnectProfile,
    proxyState: () => ({ connected, profile: activeProfile, stats, proxyIp }),
  };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onInstalled?.addListener(() => restoreState());
  chrome.runtime.onStartup?.addListener(() => restoreState());
  restoreState();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.type === "connect")
        return connectProfile(message.profile, message.settings || {});
      if (message.type === "disconnect") return disconnectProfile();
      if (message.type === "getState") return { connected, profile: activeProfile, stats, proxyIp };
      if (message.type === "getStats") return { stats, proxyIp };
      if (message.type === "setActionIconTheme") {
        await updateActionIcon(message.theme === "dark" ? "dark" : "light");
        return { ok: true };
      }
      if (message.type === "stateChanged") return reapplyStoredState();
      return { ok: false, error: "unknown message" };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!connected || !activeProfile) return;
      let size = 200;
      for (const item of details.requestBody?.raw || []) size += item.bytes?.byteLength || 0;
      stats.upload += size;
      scheduleStatsSave();
    },
    { urls: ["<all_urls>"] },
    ["requestBody"],
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!connected || !activeProfile) return;
      let size = 200;
      for (const header of details.responseHeaders || []) {
        if (header.name.toLowerCase() === "content-length") size += Number(header.value) || 0;
      }
      stats.download += size;
      scheduleStatsSave();
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"],
  );

  chrome.proxy.onProxyError?.addListener((details) =>
    console.warn("OpenFoxy proxy error", details),
  );
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizePattern,
    parsePatterns,
    buildPacScript,
    buildProxyConfig,
    proxyAddress,
    unsupportedAuthenticatedSocks5,
    applyPrivacyHeaders,
    isTrackerUrl,
  };
}
