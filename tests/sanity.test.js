const { execSync } = require("child_process");

console.log("🦊 Running OpenFoxy Basic Sanity Tests...");

(async () => {
  try {
    // Test 1: Ensure CLI help command runs without syntax errors
    const helpOutput = execSync("node index.js help").toString();
    if (!helpOutput.includes("OpenFoxy") || !helpOutput.includes("Distributed Proxy Manager")) {
      throw new Error("CLI Help text is missing or malformed.");
    }
    if (!execSync("node index.js --help").toString().includes("--version | -v")) {
      throw new Error("--help alias is missing expected output.");
    }
    if (!execSync("node index.js -h").toString().includes("--help | -h")) {
      throw new Error("-h alias is missing expected output.");
    }
    const packageVersion = require("../package.json").version;
    if (execSync("node index.js --version").toString().trim() !== packageVersion) {
      throw new Error("--version output does not match package.json.");
    }
    if (execSync("node index.js -v").toString().trim() !== packageVersion) {
      throw new Error("-v output does not match package.json.");
    }
    console.log("✅ CLI Help format verified.");

    // Test 2: Check OS detection logic (Simulated execution)
    const osRelease = execSync('cat /etc/os-release 2>/dev/null || echo "Not Linux"').toString();
    if (osRelease.includes("Not Linux")) {
      console.log("⚠️ Skipping Linux-specific integration tests on this OS.");
    } else {
      console.log("✅ Linux environment detected. Ready for GitHub Actions E2E tests.");
    }

    // Test 3: Extension profile routing helpers generate safe PAC configs.
    const {
      parsePatterns,
      buildPacScript,
      buildProxyConfig,
      proxyAddress,
      unsupportedAuthenticatedSocks5,
      applyPrivacyHeaders,
      isTrackerUrl,
    } = require("../extension/background.js");

    const profile = {
      protocol: "socks5",
      host: "proxy.example.com",
      port: "1080",
      activation: "include",
      patterns: "*.example.com\nhttps://shop.test/*",
    };
    if (proxyAddress(profile) !== "SOCKS5 proxy.example.com:1080") {
      throw new Error("Proxy address generation failed.");
    }
    if (
      JSON.stringify(parsePatterns(profile.patterns)) !==
      JSON.stringify(["example.com", "shop.test"])
    ) {
      throw new Error("Pattern parsing failed.");
    }
    const pac = buildPacScript(profile, { killSwitch: true });
    if (!pac.includes("SOCKS5 proxy.example.com:1080") || !pac.includes("example.com")) {
      throw new Error("PAC script generation failed.");
    }
    if (!pac.includes("return hit ? proxy : fallback")) {
      throw new Error("Kill switch does not protect include-mode misses.");
    }
    if (!unsupportedAuthenticatedSocks5({ ...profile, user: "u", pass: "p" })) {
      throw new Error("Authenticated SOCKS5 should be marked unsupported for Chrome.");
    }
    if (unsupportedAuthenticatedSocks5(profile)) {
      throw new Error("Unauthenticated SOCKS5 should remain available in Chrome.");
    }
    const config = buildProxyConfig(profile, { killSwitch: true });
    if (config.mode !== "pac_script" || !config.pacScript.data) {
      throw new Error("Proxy config generation failed.");
    }
    const headers = applyPrivacyHeaders(
      [{ name: "Referer", value: "https://example.com/path?q=1" }],
      { ...profile, language: "fr-FR", uaId: "chrome-mac", platform: "MacIntel" },
      { dnt: true, gpc: true, referrer: "origin", clientHints: true },
    );
    const headerMap = Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value]));
    if (
      headerMap["accept-language"] !== "fr-FR,fr;q=0.9" ||
      headerMap.dnt !== "1" ||
      headerMap.referer !== "https://example.com/"
    ) {
      throw new Error("Privacy header generation failed.");
    }
    const currentUaHeaders = applyPrivacyHeaders(
      [{ name: "User-Agent", value: "CurrentUA" }],
      { ...profile, uaId: "current" },
      {},
    );
    if (
      currentUaHeaders.find((h) => h.name.toLowerCase() === "user-agent")?.value !== "CurrentUA"
    ) {
      throw new Error("Current User-Agent should be preserved.");
    }
    if (
      !isTrackerUrl("https://www.google-analytics.com/collect") ||
      isTrackerUrl("https://example.com/app.js")
    ) {
      throw new Error("Tracker URL detection failed.");
    }
    console.log("✅ Extension profile routing helpers verified.");

    // Test 4: Extension service worker connects, authenticates proxy requests, tracks stats, and disconnects.
    const chromeMock = (() => {
      const listeners = {
        message: null,
        auth: null,
        beforeRequest: null,
        headersReceived: null,
      };
      const store = {};
      const proxyState = { value: null, clearCount: 0, failSetMessage: "" };
      const actionState = { iconPath: null };
      const mock = {
        listeners,
        store,
        proxyState,
        actionState,
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: {
            addListener(fn) {
              listeners.message = fn;
            },
          },
        },
        storage: {
          local: {
            get(key, callback) {
              const value = key ? { [key]: store[key] } : store;
              if (callback) callback(value);
              return Promise.resolve(value);
            },
            set(value, callback) {
              Object.assign(store, value);
              if (callback) callback();
              return Promise.resolve();
            },
          },
          onChanged: { addListener() {} },
        },
        proxy: {
          settings: {
            set({ value }, callback) {
              if (proxyState.failSetMessage) {
                mock.runtime.lastError = { message: proxyState.failSetMessage };
                if (callback) callback();
                delete mock.runtime.lastError;
                return;
              }
              proxyState.value = value;
              if (callback) callback();
            },
            clear(_scope, callback) {
              proxyState.value = null;
              proxyState.clearCount++;
              if (callback) callback();
            },
          },
          onProxyError: { addListener() {} },
        },
        action: {
          setIcon({ path }, callback) {
            actionState.iconPath = path;
            if (callback) callback();
            return Promise.resolve();
          },
        },
        webRequest: {
          onAuthRequired: {
            addListener(fn) {
              listeners.auth = fn;
            },
          },
          onBeforeRequest: {
            addListener(fn) {
              listeners.beforeRequest = fn;
            },
          },
          onHeadersReceived: {
            addListener(fn) {
              listeners.headersReceived = fn;
            },
          },
        },
        declarativeNetRequest: {
          updateDynamicRules(_rules) {
            return Promise.resolve();
          },
        },
      };
      return mock;
    })();

    global.chrome = chromeMock;
    const originalFetch = global.fetch;
    global.fetch = async () => ({ text: async () => "203.0.113.9\n" });
    delete require.cache[require.resolve("../extension/background.js")];
    require("../extension/background.js");
    await new Promise((resolve) => setImmediate(resolve));
    if (chromeMock.actionState.iconPath?.[16] !== "icons/icon16.png") {
      throw new Error("Extension did not initialize the light toolbar action icon.");
    }

    function sendExtensionMessage(message) {
      return new Promise((resolve) => {
        const keepAlive = chromeMock.listeners.message(message, {}, resolve);
        if (keepAlive !== true)
          throw new Error("Extension message listener should keep the channel alive.");
      });
    }

    const connectResult = await sendExtensionMessage({
      type: "connect",
      profile: {
        protocol: "residential",
        host: "127.0.0.1",
        port: "8083",
        user: "res_user",
        pass: "res_pass",
        activation: "all",
      },
      settings: { killSwitch: true },
    });
    if (!connectResult.ok) throw new Error("Extension connect message failed.");
    if (connectResult.proxyIp !== "203.0.113.9")
      throw new Error("Extension did not resolve the active proxy IP.");
    if (chromeMock.proxyState.value?.mode !== "pac_script") {
      throw new Error("Extension did not install PAC proxy settings.");
    }
    if (!chromeMock.proxyState.value.pacScript.data.includes("PROXY 127.0.0.1:8083")) {
      throw new Error("Residential profiles should use HTTP proxy mode for browser traffic.");
    }
    const authResult = await new Promise((resolve) => {
      chromeMock.listeners.auth(
        { isProxy: true, challenger: { host: "127.0.0.1", port: 8083 } },
        resolve,
      );
    });
    if (
      authResult.authCredentials?.username !== "res_user" ||
      authResult.authCredentials?.password !== "res_pass"
    ) {
      throw new Error("Extension did not provide proxy credentials on auth challenge.");
    }
    const unrelatedAuthResult = await new Promise((resolve) => {
      chromeMock.listeners.auth(
        { isProxy: true, challenger: { host: "127.0.0.2", port: 8083 } },
        resolve,
      );
    });
    if (unrelatedAuthResult.authCredentials) {
      throw new Error("Extension leaked credentials to an unrelated proxy challenge.");
    }
    const directAuthResult = await new Promise((resolve) => {
      chromeMock.listeners.auth({ isProxy: false }, resolve);
    });
    if (directAuthResult.authCredentials) {
      throw new Error("Extension should not answer origin-server auth with proxy credentials.");
    }
    chromeMock.listeners.beforeRequest({ requestBody: { raw: [{ bytes: Buffer.alloc(10) }] } });
    chromeMock.listeners.headersReceived({
      responseHeaders: [{ name: "Content-Length", value: "25" }],
    });
    const statsResult = await sendExtensionMessage({ type: "getStats" });
    if (statsResult.stats.upload < 210 || statsResult.stats.download < 225) {
      throw new Error("Extension traffic stats did not update from webRequest events.");
    }
    if (statsResult.proxyIp !== "203.0.113.9") {
      throw new Error("Extension did not return the active proxy IP with stats.");
    }
    const disconnectResult = await sendExtensionMessage({ type: "disconnect" });
    if (!disconnectResult.ok || chromeMock.proxyState.value !== null) {
      throw new Error("Extension disconnect did not clear proxy settings.");
    }
    chromeMock.proxyState.value = { mode: "pac_script" };
    const socksResult = await sendExtensionMessage({
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
    if (socksResult.ok || !String(socksResult.error || "").includes("cannot authenticate SOCKS5")) {
      throw new Error("Extension should reject authenticated SOCKS5 profiles in Chrome.");
    }
    if (chromeMock.proxyState.value !== null) {
      throw new Error("Rejected authenticated SOCKS5 should clear proxy settings.");
    }
    const socksAuthResult = await new Promise((resolve) => {
      chromeMock.listeners.auth(
        { isProxy: true, challenger: { host: "127.0.0.1", port: 1080 } },
        resolve,
      );
    });
    if (socksAuthResult.authCredentials) {
      throw new Error(
        "Rejected authenticated SOCKS5 should leave no proxy auth credentials active.",
      );
    }
    chromeMock.proxyState.value = { mode: "pac_script" };
    chromeMock.proxyState.failSetMessage = "controlled proxy settings failure";
    const failedHttpResult = await sendExtensionMessage({
      type: "connect",
      profile: {
        protocol: "http",
        host: "127.0.0.1",
        port: "8080",
        user: "http_user",
        pass: "http_pass",
        activation: "all",
      },
      settings: { killSwitch: true },
    });
    chromeMock.proxyState.failSetMessage = "";
    if (
      failedHttpResult.ok ||
      !String(failedHttpResult.error || "").includes("controlled proxy settings failure")
    ) {
      throw new Error("Extension should surface proxy API failures during connect.");
    }
    if (chromeMock.proxyState.value !== null) {
      throw new Error("Failed proxy API connect should clear stale proxy settings.");
    }
    await sendExtensionMessage({ type: "setActionIconTheme", theme: "dark" });
    if (chromeMock.actionState.iconPath?.[16] !== "icons/dark/icon16.png") {
      throw new Error("Extension did not switch to the dark toolbar action icon.");
    }
    chromeMock.store["openfoxy.v2"] = { actionIconTheme: "light", settings: { theme: "dark" } };
    await sendExtensionMessage({ type: "stateChanged" });
    if (chromeMock.actionState.iconPath?.[16] !== "icons/icon16.png") {
      throw new Error("Extension did not switch to the light theme action icon.");
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    delete global.chrome;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("../extension/background.js")];
    require("../extension/background.js");
    console.log("✅ Extension service worker runtime flow verified.");

    // Test 5: CLI rejects unsupported Docker protocol before side effects.
    try {
      execSync("node index.js docker user pass 8000 badproto", { stdio: "pipe" });
      throw new Error("Invalid protocol was accepted.");
    } catch (error) {
      if (error.message === "Invalid protocol was accepted.") throw error;
      const out = String(error.stderr || "") + String(error.stdout || "");
      if (!out.includes("Invalid protocol")) {
        throw new Error("Invalid protocol error message is missing.");
      }
    }
    console.log("✅ CLI protocol validation verified.");

    // Test 6: CLI rejects shell-like port input before command interpolation.
    try {
      execSync("node index.js docker user pass '8000;touch /tmp/openfoxy-bad' http", {
        stdio: "pipe",
      });
      throw new Error("Invalid port was accepted.");
    } catch (error) {
      if (error.message === "Invalid port was accepted.") throw error;
      const out = String(error.stderr || "") + String(error.stdout || "");
      if (!out.includes("Invalid port")) {
        throw new Error("Invalid port error message is missing.");
      }
    }
    console.log("✅ CLI strict port validation verified.");

    console.log("\n🎉 Basic tests passed! Run GitHub Actions for full Functional Testing.");
  } catch (error) {
    console.error("❌ Test Failed:", error.message);
    process.exit(1);
  }
})();
