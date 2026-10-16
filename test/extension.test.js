// Tests for the Chromium MV3 extension. The extension files are classic scripts, so they are
// executed with node:vm inside a context that provides a mocked `chrome` and friends; their
// top-level function declarations become globals of that context.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension");
const CONFIG_KEY = "openfoxy.config";
const SESSION_KEY = "openfoxy.session";

const readExtensionFile = (name) => fs.readFileSync(path.join(EXTENSION_DIR, name), "utf8");

// Objects created inside a vm context have a different realm's prototypes, which
// assert.deepStrictEqual rejects; round-tripping through JSON normalizes them.
const plain = (value) => JSON.parse(JSON.stringify(value));

function runScript(context, name) {
  vm.runInContext(readExtensionFile(name), context, { filename: name });
}

// Deterministic replacement for setTimeout: callbacks only run when the test flushes them.
function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async flush() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function createChromeMock(initialStore = {}) {
  const listeners = {};
  const store = { ...initialStore };
  const state = {
    proxyValue: null,
    failSetMessage: "",
    iconPath: null,
    dnrCalls: [],
    dnrRules: [],
    storageWrites: [],
  };
  const event = (name) => ({
    addListener(fn) {
      listeners[name] = fn;
    },
  });
  const chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message"),
      getManifest: () => ({ version: "9.9.9" }),
    },
    storage: {
      local: {
        async get(keys) {
          const wanted = typeof keys === "string" ? [keys] : keys || Object.keys(store);
          return Object.fromEntries(wanted.filter((key) => key in store).map((k) => [k, store[k]]));
        },
        async set(values) {
          state.storageWrites.push(Object.keys(values));
          Object.assign(store, values);
        },
      },
    },
    proxy: {
      settings: {
        set({ value }, callback) {
          if (state.failSetMessage) {
            chrome.runtime.lastError = { message: state.failSetMessage };
            callback();
            chrome.runtime.lastError = undefined;
            return;
          }
          state.proxyValue = value;
          callback();
        },
        clear(_details, callback) {
          state.proxyValue = null;
          callback();
        },
      },
      onProxyError: event("proxyError"),
    },
    action: {
      async setIcon({ path: iconPath }) {
        state.iconPath = iconPath;
      },
    },
    webRequest: {
      onAuthRequired: event("auth"),
      onBeforeRequest: event("beforeRequest"),
      onHeadersReceived: event("headersReceived"),
    },
    declarativeNetRequest: {
      async updateDynamicRules({ removeRuleIds, addRules }) {
        state.dnrCalls.push({ removeRuleIds, addRules });
        state.dnrRules = addRules;
      },
    },
  };
  return { chrome, listeners, store, state };
}

// Loads background.js (and, through importScripts, presets.js) into a fresh context.
async function loadBackground({ store, ipText = "203.0.113.9\n" } = {}) {
  const mock = createChromeMock(store);
  const timers = createFakeTimers();
  const fetchCalls = [];
  const context = vm.createContext({
    chrome: mock.chrome,
    console: { warn() {}, log() {}, error() {} },
    URL,
    AbortController,
    AbortSignal,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (url) => {
      fetchCalls.push(url);
      return { text: async () => ipText };
    },
    importScripts: (name) => runScript(context, name),
  });
  runScript(context, "background.js");
  await vm.runInContext("ready", context);

  const send = (message) =>
    new Promise((resolve) => {
      const keepAlive = mock.listeners.message(message, {}, resolve);
      assert.equal(keepAlive, true, "message listener must keep the channel open");
    });
  const authChallenge = (details) =>
    new Promise((resolve) => mock.listeners.auth(details, resolve));

  return { ...mock, context, timers, fetchCalls, send, authChallenge };
}

const residentialProfile = {
  id: "res",
  protocol: "residential",
  host: "127.0.0.1",
  port: "8083",
  user: "res_user",
  pass: "res_pass",
  activation: "all",
};

test("presets are the single source of User-Agent strings", () => {
  const context = vm.createContext({});
  runScript(context, "presets.js");
  const presets = vm.runInContext("OpenFoxyPresets", context);

  assert.ok(Object.isFrozen(presets));
  assert.deepEqual(plain(presets.userAgents.map((preset) => preset.id)), [
    "current",
    "chrome-win",
    "chrome-mac",
    "safari-mac",
    "firefox-win",
    "ios",
    "android",
  ]);
  for (const preset of presets.userAgents.filter(
    (p) => p.id.startsWith("chrome") || p.id === "android",
  )) {
    assert.match(preset.ua, /Chrome\/\d+\.0\.0\.0 /, `${preset.id} must use the reduced UA format`);
    assert.doesNotMatch(preset.ua, /Chrome\/126/, `${preset.id} must not be stale`);
  }

  const resolve = (profile) => presets.resolveUserAgent(profile);
  assert.equal(resolve({ uaId: "current" }), null);
  assert.equal(resolve({}), null);
  assert.equal(resolve(null), null);
  assert.equal(resolve({ uaId: "unknown" }), null);
  assert.match(resolve({ uaId: "firefox-win" }), /Firefox\/\d+\.0$/);
  assert.equal(resolve({ uaId: "chrome-win", uaCustom: "Custom/1.0" }), "Custom/1.0");

  // Only presets.js may contain User-Agent strings.
  for (const file of ["background.js", "content.js", "page.js", "popup.js", "popup.html"]) {
    assert.doesNotMatch(readExtensionFile(file), /Mozilla\/5\.0/, `${file} duplicates presets`);
  }
});

test("profile routing helpers generate safe PAC configs", async () => {
  const { context } = await loadBackground();
  const call = (expression) => plain(vm.runInContext(expression, context));
  const profile = {
    protocol: "socks5",
    host: "proxy.example.com",
    port: "1080",
    activation: "include",
    patterns: "*.example.com\nhttps://shop.test/*",
  };
  context.profile = profile;

  assert.equal(call("proxyAddress(profile)"), "SOCKS5 proxy.example.com:1080");
  assert.deepEqual(call("parsePatterns(profile.patterns)"), ["example.com", "shop.test"]);

  const pac = vm.runInContext("buildPacScript(profile, { killSwitch: true })", context);
  assert.ok(pac.includes("SOCKS5 proxy.example.com:1080"));
  assert.ok(pac.includes("example.com"));
  assert.ok(
    pac.includes("return hit ? proxy : fallback"),
    "kill switch must protect include-mode misses",
  );
  assert.ok(pac.includes('var fallback = "PROXY 127.0.0.1:9"'));
  const openPac = vm.runInContext("buildPacScript(profile, {})", context);
  assert.ok(openPac.includes('var fallback = "DIRECT"'));

  context.withAuth = { ...profile, user: "u", pass: "p" };
  assert.equal(vm.runInContext("unsupportedAuthenticatedSocks5(withAuth)", context), true);
  assert.equal(vm.runInContext("unsupportedAuthenticatedSocks5(profile)", context), false);

  const config = call("buildProxyConfig(profile, { killSwitch: true })");
  assert.equal(config.mode, "pac_script");
  assert.ok(config.pacScript.data);
  assert.equal(config.pacScript.mandatory, true);
  assert.deepEqual(call("buildProxyConfig(null)"), { mode: "direct" });
});

test("buildDynamicRules is pure and implements UI-exposed privacy settings", async () => {
  const { context } = await loadBackground();
  const rules = (profile, settings) => {
    context.input = { profile, settings };
    return plain(vm.runInContext("buildDynamicRules(input.profile, input.settings)", context));
  };

  assert.deepEqual(rules(null, {}), []);
  assert.deepEqual(rules({ uaId: "current", language: "" }, {}), []);

  const [headerRule] = rules(
    { uaId: "chrome-mac", language: "fr-FR" },
    { dnt: true, gpc: true, clientHints: true, stripReferrer: true },
  );
  assert.equal(headerRule.action.type, "modifyHeaders");
  const headers = Object.fromEntries(
    headerRule.action.requestHeaders.map((h) => [
      h.header,
      h.operation === "remove" ? null : h.value,
    ]),
  );
  assert.match(headers["User-Agent"], /Macintosh.*Chrome\/\d+\.0\.0\.0/);
  assert.equal(headers["Accept-Language"], "fr-FR,fr;q=0.9");
  assert.equal(headers.DNT, "1");
  assert.equal(headers["Sec-GPC"], "1");
  assert.equal(headers["Sec-CH-UA-Mobile"], "?0");
  assert.equal(headers["Sec-CH-UA-Platform"], '"macOS"');
  assert.equal(headers.Referer, null, "Referer must be removed");

  const mobileHeaders = rules({ uaId: "android" }, { clientHints: true })[0].action.requestHeaders;
  assert.ok(mobileHeaders.some((h) => h.header === "Sec-CH-UA-Mobile" && h.value === "?1"));
  assert.ok(
    mobileHeaders.some((h) => h.header === "Sec-CH-UA-Platform" && h.value === '"Android"'),
  );
  const iosHeaders = rules({ uaId: "ios" }, { clientHints: true })[0].action.requestHeaders;
  assert.ok(iosHeaders.some((h) => h.header === "Sec-CH-UA-Platform" && h.value === '"iOS"'));

  const names = (profile, settings) =>
    (rules(profile, settings)[0]?.action.requestHeaders || []).map((h) => h.header);
  assert.ok(!names({ uaId: "current" }, { clientHints: true }).includes("Sec-CH-UA-Mobile"));
  assert.ok(!names({ uaId: "chrome-win" }, { clientHints: false }).includes("Sec-CH-UA-Mobile"));
  assert.ok(!names({ uaId: "chrome-win" }, {}).includes("Referer"));
  assert.ok(!names({ uaId: "current" }, { dnt: false, gpc: false }).includes("DNT"));
  assert.deepEqual(names({ uaId: "current" }, { stripReferrer: true }), ["Referer"]);

  const blockRules = rules(null, { blockTrackers: true });
  assert.ok(blockRules.length >= 10);
  assert.ok(blockRules.every((rule) => rule.action.type === "block"));
  const filters = blockRules.map((rule) => rule.condition.urlFilter);
  assert.ok(filters.includes("||doubleclick.net^"));
  assert.ok(filters.includes("||facebook.com/tr^"));
  assert.ok(
    filters.every((filter) => filter.startsWith("||") && filter.endsWith("^")),
    "every tracker filter must be domain-anchored",
  );

  // Rule IDs are unique, stable between calls and within the range cleared on every update.
  const all = rules({ uaId: "chrome-win" }, { blockTrackers: true, dnt: true });
  const ids = all.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    ids,
    rules({ uaId: "chrome-win" }, { blockTrackers: true, dnt: true }).map((r) => r.id),
  );
  const removable = plain(vm.runInContext("DNR_RULE_IDS", context));
  assert.ok(ids.every((id) => removable.includes(id)));
  assert.equal(removable.length, 1 + blockRules.length);
});

test("every connection setting is exposed in the popup", async () => {
  const { context } = await loadBackground();
  const keys = plain(vm.runInContext("CONNECTION_SETTING_KEYS", context));
  const html = readExtensionFile("popup.html");
  for (const key of keys) {
    assert.match(html, new RegExp(`data-key="${key}"`), `popup has no control for ${key}`);
  }
  assert.doesNotMatch(html, /data-key="referrer"/);
});

test("service worker connects, authenticates the proxy, tracks stats and disconnects", async () => {
  const env = await loadBackground();
  const { state, send, authChallenge, listeners } = env;
  assert.equal(state.iconPath[16], "icons/icon16.png", "light toolbar icon on startup");

  const connect = await send({
    type: "connect",
    profile: residentialProfile,
    settings: { killSwitch: true },
  });
  assert.equal(connect.ok, true);
  assert.equal(connect.proxyIp, "203.0.113.9");
  assert.equal(state.proxyValue.mode, "pac_script");
  assert.ok(
    state.proxyValue.pacScript.data.includes("PROXY 127.0.0.1:8083"),
    "residential profiles use HTTP proxy mode for browser traffic",
  );

  const granted = await authChallenge({
    isProxy: true,
    challenger: { host: "127.0.0.1", port: 8083 },
  });
  assert.deepEqual(plain(granted.authCredentials), { username: "res_user", password: "res_pass" });
  const unrelated = await authChallenge({
    isProxy: true,
    challenger: { host: "127.0.0.2", port: 8083 },
  });
  assert.equal(unrelated.authCredentials, undefined, "credentials must not leak to other proxies");
  const originAuth = await authChallenge({ isProxy: false });
  assert.equal(originAuth.authCredentials, undefined, "origin-server auth is not ours to answer");

  listeners.beforeRequest({ requestBody: { raw: [{ bytes: Buffer.alloc(10) }] } });
  listeners.headersReceived({ responseHeaders: [{ name: "Content-Length", value: "25" }] });
  const stats = await send({ type: "getStats" });
  assert.ok(stats.stats.upload >= 210);
  assert.ok(stats.stats.download >= 225);
  assert.equal(stats.proxyIp, "203.0.113.9");

  const disconnect = await send({ type: "disconnect" });
  assert.equal(disconnect.ok, true);
  assert.equal(state.proxyValue, null);
  assert.deepEqual(plain(state.dnrRules), []);
  assert.equal((await send({ type: "getState" })).connected, false);
});

test("authenticated SOCKS5 is rejected and leaves no proxy or credentials behind", async () => {
  const env = await loadBackground();
  const { state, send, authChallenge } = env;
  state.proxyValue = { mode: "pac_script" };

  const result = await send({
    type: "connect",
    profile: {
      protocol: "socks5",
      host: "127.0.0.1",
      port: "1080",
      user: "socks_user",
      pass: "socks_pass",
      activation: "all",
    },
    settings: { killSwitch: true },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot authenticate SOCKS5/);
  assert.equal(state.proxyValue, null);
  const auth = await authChallenge({
    isProxy: true,
    challenger: { host: "127.0.0.1", port: 1080 },
  });
  assert.equal(auth.authCredentials, undefined);
  assert.match(env.store[SESSION_KEY].connectionError, /cannot authenticate SOCKS5/);
  assert.equal(env.store[SESSION_KEY].connected, false);
});

test("proxy API failures are surfaced and clear stale proxy settings", async () => {
  const env = await loadBackground();
  const { state, send } = env;
  state.proxyValue = { mode: "pac_script" };
  state.failSetMessage = "controlled proxy settings failure";

  const result = await send({
    type: "connect",
    profile: { ...residentialProfile, protocol: "http", port: "8080" },
    settings: { killSwitch: true },
  });
  state.failSetMessage = "";
  assert.equal(result.ok, false);
  assert.match(result.error, /controlled proxy settings failure/);
  assert.equal(state.proxyValue, null);
  assert.equal((await send({ type: "getState" })).connected, false);
});

test("toolbar icon follows the theme", async () => {
  const env = await loadBackground();
  await env.send({ type: "setActionIconTheme", theme: "dark" });
  assert.equal(env.state.iconPath[16], "icons/dark/icon16.png");

  env.store[CONFIG_KEY] = { actionIconTheme: "light", settings: { theme: "dark" } };
  await env.send({ type: "stateChanged" });
  assert.equal(env.state.iconPath[16], "icons/icon16.png");
});

test("background persists only the session key, never the popup-owned config", async () => {
  const config = {
    profiles: [residentialProfile],
    activeId: "res",
    settings: { killSwitch: true },
  };
  const env = await loadBackground({ store: { [CONFIG_KEY]: config } });
  await env.send({ type: "connect", profile: residentialProfile, settings: { killSwitch: true } });
  env.listeners.beforeRequest({ requestBody: { raw: [] } });
  await env.timers.flush();

  assert.deepEqual(plain(env.store[CONFIG_KEY]), config);
  assert.ok(env.state.storageWrites.every((keys) => keys.length === 1 && keys[0] === SESSION_KEY));
  const session = env.store[SESSION_KEY];
  assert.equal(session.connected, true);
  assert.equal(session.proxyIp, "203.0.113.9");
  assert.equal(session.stats.upload, 200);
  assert.equal(session.connectionError, "");
});

test("stateChanged only reconnects when the profile or connection settings changed", async () => {
  const settings = { killSwitch: true, blockTrackers: false, theme: "dark" };
  const config = { profiles: [residentialProfile], activeId: "res", settings };
  const env = await loadBackground({ store: { [CONFIG_KEY]: config } });
  await env.send({ type: "connect", profile: residentialProfile, settings });
  env.listeners.beforeRequest({ requestBody: { raw: [{ bytes: Buffer.alloc(300) }] } });
  const baselineFetches = env.fetchCalls.length;
  const baselineDnr = env.state.dnrCalls.length;

  // Opening the popup re-sends the unchanged config.
  await env.send({ type: "stateChanged" });
  assert.equal(env.fetchCalls.length, baselineFetches, "no new IP lookup");
  assert.equal(env.state.dnrCalls.length, baselineDnr, "rules untouched");
  assert.equal((await env.send({ type: "getStats" })).stats.upload, 500, "stats preserved");

  // Theme and fingerprint toggles do not affect the connection either.
  env.store[CONFIG_KEY] = {
    ...config,
    settings: { ...settings, theme: "light", canvasNoise: false },
  };
  await env.send({ type: "stateChanged" });
  assert.equal(env.fetchCalls.length, baselineFetches);
  assert.equal((await env.send({ type: "getStats" })).stats.upload, 500);

  // A connection-relevant setting does reconnect and reapply rules.
  env.store[CONFIG_KEY] = { ...config, settings: { ...settings, blockTrackers: true } };
  await env.send({ type: "stateChanged" });
  assert.equal(env.fetchCalls.length, baselineFetches + 1);
  assert.equal((await env.send({ type: "getStats" })).stats.upload, 0, "reconnect resets stats");
  assert.ok(env.state.dnrRules.some((rule) => rule.action.type === "block"));

  // So does editing the active profile.
  const edited = { ...residentialProfile, port: "8084" };
  env.store[CONFIG_KEY] = {
    profiles: [edited],
    activeId: "res",
    settings: { ...settings, blockTrackers: true },
  };
  await env.send({ type: "stateChanged" });
  assert.ok(env.state.proxyValue.pacScript.data.includes("PROXY 127.0.0.1:8084"));

  // Removing the active profile disconnects.
  env.store[CONFIG_KEY] = { profiles: [], activeId: null, settings };
  await env.send({ type: "stateChanged" });
  assert.equal((await env.send({ type: "getState" })).connected, false);
  assert.equal(env.state.proxyValue, null);
});

test("stateChanged while disconnected does nothing", async () => {
  const config = { profiles: [residentialProfile], activeId: "res", settings: {} };
  const env = await loadBackground({ store: { [CONFIG_KEY]: config } });
  const result = await env.send({ type: "stateChanged" });
  assert.deepEqual(plain(result), { ok: true });
  assert.equal(env.state.proxyValue, null);
  assert.equal(env.fetchCalls.length, 0);
});

test("worker restart resumes the stored session and keeps its counters", async () => {
  const config = {
    profiles: [residentialProfile],
    activeId: "res",
    settings: { killSwitch: true },
  };
  const session = {
    connected: true,
    stats: { upload: 1234, download: 5678 },
    proxyIp: "198.51.100.7",
    connectionError: "",
  };
  const env = await loadBackground({ store: { [CONFIG_KEY]: config, [SESSION_KEY]: session } });
  const state = await env.send({ type: "getState" });
  assert.equal(state.connected, true);
  assert.deepEqual(plain(state.stats), session.stats);
  assert.equal(state.proxyIp, "198.51.100.7");
  assert.equal(env.fetchCalls.length, 0);
  assert.ok(env.state.proxyValue.pacScript.data.includes("PROXY 127.0.0.1:8083"));
});

test("content script dispatches the resolved User-Agent only while connected", async () => {
  const profile = { ...residentialProfile, uaId: "chrome-win" };
  const mock = createChromeMock({
    [CONFIG_KEY]: { profiles: [profile], activeId: "res", settings: { canvasNoise: true } },
    [SESSION_KEY]: { connected: true },
  });
  let onChanged;
  mock.chrome.storage.onChanged = { addListener: (fn) => (onChanged = fn) };
  const events = [];
  const context = vm.createContext({
    chrome: mock.chrome,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    window: { dispatchEvent: (event) => events.push(event) },
  });
  runScript(context, "presets.js");
  runScript(context, "content.js");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "openfoxy:apply-profile");
  assert.equal(typeof events[0].detail, "string", "detail must be JSON to cross worlds");
  const detail = JSON.parse(events[0].detail);
  assert.equal(detail.profile.id, "res");
  assert.deepEqual(detail.settings, { canvasNoise: true });
  assert.match(detail.userAgent, /Windows NT 10\.0.*Chrome\/\d+\.0\.0\.0/);

  // Traffic-only session updates must not re-dispatch.
  onChanged({ [SESSION_KEY]: { newValue: { connected: true, stats: { upload: 9 } } } }, "local");
  assert.equal(events.length, 1);
  // Disconnecting dispatches a null config.
  onChanged({ [SESSION_KEY]: { newValue: { connected: false } } }, "local");
  assert.equal(events.length, 2);
  assert.equal(JSON.parse(events[1].detail), null);
});

test("popup init does not notify the worker or write storage", async () => {
  const messages = [];
  const writes = [];
  const listeners = {};
  const sets = new Map();
  const makeStub = (id) => {
    const target = function () {};
    return new Proxy(target, {
      get(_target, key) {
        if (typeof key === "symbol") return undefined;
        if (key === "addEventListener") return (type, fn) => (listeners[`${id}:${type}`] = fn);
        if (key === "dataset") return {};
        return makeStub(`${id}.${key}`);
      },
      set(_target, key, value) {
        sets.set(`${id}.${String(key)}`, value);
        return true;
      },
      apply: () => makeStub(`${id}()`),
    });
  };
  const stubs = new Map();
  const context = vm.createContext({
    navigator: { userAgent: "TestUA" },
    document: {
      documentElement: makeStub("html"),
      createElement: (tag) => makeStub(`<${tag}>`),
      getElementById: (id) => stubs.get(id) || stubs.set(id, makeStub(id)).get(id),
      querySelectorAll: () => makeStub("all"),
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "2.0.0" }),
        async sendMessage(message) {
          messages.push(message.type);
          if (message.type === "getState") {
            return { connected: true, stats: { upload: 5, download: 6 }, proxyIp: "203.0.113.9" };
          }
          return { ok: true };
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set(values) {
            writes.push(Object.keys(values));
          },
        },
      },
    },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout,
  });
  context.window = context;
  runScript(context, "presets.js");
  runScript(context, "popup.js");
  for (let i = 0; i < 50 && ![...sets.keys()].some((k) => k.startsWith("statUp.")); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.ok(sets.get("statUp.textContent"), "popup rendered");
  assert.equal(sets.get("aboutVersion.textContent"), "OpenFoxy · v2.0.0");
  assert.deepEqual(
    messages.filter((t) => t !== "getState" && t !== "setActionIconTheme"),
    [],
  );
  assert.ok(!messages.includes("stateChanged"), "init must not trigger a reconnect");
  assert.deepEqual(writes, [], "init must not write storage");

  // A real user action does persist the config and notify the worker.
  await listeners["themeQuickToggle:click"]();
  assert.deepEqual(writes, [[CONFIG_KEY]]);
  assert.ok(messages.includes("stateChanged"));
});

test("manifest declares page.js in the MAIN world and exposes no resources", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "2.0.0");
  assert.ok(!manifest.permissions.includes("tabs"), "unused tabs permission");
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.ok(Number(manifest.minimum_chrome_version) >= 111);

  const isolated = manifest.content_scripts.find((script) => script.js.includes("content.js"));
  assert.deepEqual(isolated.js, ["presets.js", "content.js"]);
  assert.notEqual(isolated.world, "MAIN");
  const main = manifest.content_scripts.find((script) => script.js.includes("page.js"));
  assert.equal(main.world, "MAIN");
  assert.equal(main.run_at, "document_start");

  const background = readExtensionFile("background.js");
  assert.match(background, /importScripts\("presets\.js"\)/);
  assert.doesNotMatch(readExtensionFile("content.js"), /getURL|createElement\("script"\)/);
});

test("production sources carry no test hooks or dead header helpers", () => {
  for (const file of ["background.js", "content.js", "page.js", "popup.js", "presets.js"]) {
    const source = readExtensionFile(file);
    assert.doesNotMatch(source, /module\.exports|openFoxyTestApi/, `${file} has test hooks`);
  }
  assert.doesNotMatch(readExtensionFile("background.js"), /applyPrivacyHeaders|isTrackerUrl/);
});

test("fontMask is implemented in page.js", () => {
  const pageSource = readExtensionFile("page.js");
  assert.ok(pageSource.includes("function spoofFonts"));
  assert.ok(pageSource.includes("settings.fontMask"));
  assert.ok(pageSource.includes("FontFaceSet.prototype"));
  assert.ok(pageSource.includes("CanvasRenderingContext2D.prototype.measureText"));
});

test("popup has the OpenFoxy brand, loads presets first and has no placeholder text", () => {
  const html = readExtensionFile("popup.html");
  assert.doesNotMatch(html, /No .* implemented yet|Notifications<\/span>/);
  assert.doesNotMatch(html, /PROXY<b>FOXY<\/b>|lorem ipsum|TODO/i);
  assert.ok(html.includes("OPEN<b>FOXY</b>"));
  assert.ok(html.indexOf('src="presets.js"') !== -1);
  assert.ok(html.indexOf('src="presets.js"') < html.indexOf('src="popup.js"'));
});
