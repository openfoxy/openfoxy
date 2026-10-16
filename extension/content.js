// Isolated-world bridge: reads the stored profile and hands it to page.js (MAIN world)
// through a CustomEvent. Only the popup-owned config and the background-owned
// `connected` flag are needed here.
(function () {
  const CONFIG_KEY = "openfoxy.config";
  const SESSION_KEY = "openfoxy.session";
  const EVENT_NAME = "openfoxy:apply-profile";

  let config = null;
  let session = null;
  let lastDetailJson;

  function buildDetail() {
    if (!session?.connected || !Array.isArray(config?.profiles)) return null;
    const profile = config.profiles.find((p) => p.id === config.activeId);
    if (!profile) return null;
    return {
      profile,
      settings: config.settings || {},
      userAgent: globalThis.OpenFoxyPresets.resolveUserAgent(profile),
    };
  }

  // The session key changes on every traffic update, so skip events that carry nothing new.
  function dispatch() {
    const json = JSON.stringify(buildDetail());
    if (json === lastDetailJson) return;
    lastDetailJson = json;
    // A JSON string crosses from the isolated world to the MAIN world intact; objects may not.
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: json }));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(CONFIG_KEY in changes || SESSION_KEY in changes)) return;
    if (CONFIG_KEY in changes) config = changes[CONFIG_KEY].newValue || null;
    if (SESSION_KEY in changes) session = changes[SESSION_KEY].newValue || null;
    dispatch();
  });

  chrome.storage.local.get([CONFIG_KEY, SESSION_KEY]).then((data) => {
    config = data[CONFIG_KEY] || null;
    session = data[SESSION_KEY] || null;
    dispatch();
  });
})();
