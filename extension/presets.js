// Single source of truth for User-Agent presets. Loaded as a classic script by the service
// worker (importScripts), the popup (<script>) and the isolated-world content script.
// Chrome's reduced UA format freezes everything except the major version, and Safari
// freezes the macOS / iOS tokens, so only the browser major versions below change.
(function () {
  const userAgents = Object.freeze([
    // `ua: null` means "keep the browser's real User-Agent".
    Object.freeze({ id: "current", label: "Current", ua: null }),
    Object.freeze({
      id: "chrome-win",
      label: "Chrome · Win",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    }),
    Object.freeze({
      id: "chrome-mac",
      label: "Chrome · Mac",
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    }),
    Object.freeze({
      id: "safari-mac",
      label: "Safari · Mac",
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
    }),
    Object.freeze({
      id: "firefox-win",
      label: "Firefox · Win",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0",
    }),
    Object.freeze({
      id: "ios",
      label: "iPhone",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    }),
    Object.freeze({
      id: "android",
      label: "Android",
      ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36",
    }),
  ]);

  // Returns the User-Agent a profile should present, or null to keep the browser's own.
  function resolveUserAgent(profile) {
    const custom = String(profile?.uaCustom || "").trim();
    if (custom) return custom;
    return userAgents.find((preset) => preset.id === profile?.uaId)?.ua ?? null;
  }

  globalThis.OpenFoxyPresets = Object.freeze({ userAgents, resolveUserAgent });
})();
