(function () {
  const STORE_KEY = "openfoxy.v2";
  const EVENT_NAME = "openfoxy:apply-profile";

  function activeConfig(store) {
    if (!store?.connected || !Array.isArray(store.profiles)) return null;
    const profile = store.profiles.find((p) => p.id === store.activeId);
    return profile ? { profile, settings: store.settings || {} } : null;
  }

  function readStore() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORE_KEY, (data) => resolve(data?.[STORE_KEY] || null));
    });
  }

  function dispatch(config) {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: config }));
  }

  function injectPageScript() {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page.js");
      script.async = false;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = resolve;
      (document.documentElement || document.head).prepend(script);
    });
  }

  Promise.all([injectPageScript(), readStore()]).then(([, store]) => dispatch(activeConfig(store)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORE_KEY]) dispatch(activeConfig(changes[STORE_KEY].newValue));
  });
})();
