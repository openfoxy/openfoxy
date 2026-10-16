// Storage ownership: the popup writes CONFIG_KEY, the background worker writes SESSION_KEY.
// The popup only ever reads live connection state from the worker via messages.
const CONFIG_KEY = "openfoxy.config";

const EMOJI_FLAGS = [
  ["🇫🇷", "France"],
  ["🇩🇪", "Germany"],
  ["🇬🇧", "United Kingdom"],
  ["🇺🇸", "United States"],
  ["🇨🇦", "Canada"],
  ["🇯🇵", "Japan"],
  ["🇸🇬", "Singapore"],
  ["🇳🇱", "Netherlands"],
  ["🇸🇪", "Sweden"],
  ["🇨🇭", "Switzerland"],
  ["🇪🇸", "Spain"],
  ["🇮🇹", "Italy"],
  ["🇧🇷", "Brazil"],
  ["🇦🇺", "Australia"],
  ["🇰🇷", "South Korea"],
  ["🇭🇰", "Hong Kong"],
  ["🇮🇳", "India"],
  ["🇲🇽", "Mexico"],
  ["🇵🇱", "Poland"],
  ["🇹🇷", "Turkey"],
  ["🇦🇪", "UAE"],
  ["🇿🇦", "South Africa"],
].map(([e, n]) => ({ e, n }));
const EMOJI_ANIMALS = [
  ["🦊", "Fox"],
  ["🐺", "Wolf"],
  ["🦁", "Lion"],
  ["🐯", "Tiger"],
  ["🐻", "Bear"],
  ["🐼", "Panda"],
  ["🦅", "Eagle"],
  ["🦉", "Owl"],
].map(([e, n]) => ({ e, n }));
const EMOJI_OBJECTS = [
  ["🌐", "Global"],
  ["🔒", "Secure"],
  ["⚡", "Fast"],
  ["🎯", "Target"],
  ["🚀", "Rocket"],
  ["💎", "Premium"],
  ["🔥", "Fire"],
  ["⭐", "Star"],
].map(([e, n]) => ({ e, n }));

const UA_PRESETS = globalThis.OpenFoxyPresets.userAgents;
const PRESETS = {
  platform: [
    ["Win32", "Windows"],
    ["MacIntel", "macOS"],
    ["Linux x86_64", "Linux"],
    ["iPhone", "iPhone"],
    ["Android", "Android"],
  ],
  resolution: [
    ["1920x1080", "1920×1080"],
    ["1366x768", "1366×768"],
    ["1536x864", "1536×864"],
    ["1440x900", "1440×900"],
    ["390x844", "390×844"],
  ],
  language: [
    ["en-US", "English (US)"],
    ["en-GB", "English (UK)"],
    ["fr-FR", "Français"],
    ["de-DE", "Deutsch"],
    ["es-ES", "Español"],
    ["ja-JP", "日本語"],
    ["zh-CN", "中文"],
  ],
  hardware: [
    ["2", "2 cores"],
    ["4", "4 cores"],
    ["8", "8 cores"],
    ["16", "16 cores"],
  ],
  memory: [
    ["4", "4 GB"],
    ["8", "8 GB"],
    ["16", "16 GB"],
    ["32", "32 GB"],
  ],
  colorDepth: [
    ["24", "24-bit"],
    ["30", "30-bit"],
    ["32", "32-bit"],
    ["48", "48-bit HDR"],
  ],
  pixelRatio: [
    ["1", "1×"],
    ["1.25", "1.25×"],
    ["1.5", "1.5×"],
    ["2", "2× Retina"],
    ["3", "3× Mobile"],
  ],
  touch: [
    ["0", "0 (Desktop)"],
    ["1", "1"],
    ["5", "5"],
    ["10", "10 (Tablet)"],
  ],
  network: [
    ["4g", "4G"],
    ["3g", "3G"],
    ["2g", "2G"],
    ["slow-2g", "Slow 2G"],
    ["wifi", "Wi-Fi"],
  ],
};

const DEFAULT_SETTINGS = {
  theme: "dark",
  reducedMotion: false,
  autoConnect: false,
  killSwitch: true,
  canvasNoise: true,
  audioNoise: true,
  webglSpoof: true,
  fontMask: true,
  mathJitter: false,
  plugins: true,
  clientHints: true,
  cpuSpoof: true,
  memorySpoof: true,
  batteryMask: true,
  netInfo: true,
  touchPoints: true,
  screenRes: true,
  colorDepth: true,
  pixelRatio: true,
  prefersScheme: false,
  blockTrackers: true,
  stripReferrer: false,
  dnt: false,
  gpc: true,
  permGeo: true,
  permCam: true,
  permMic: true,
  permClip: true,
  permDevices: true,
};

const $ = (id) => document.getElementById(id);
// Persisted fields (profiles, activeId, actionIconTheme, settings) come from CONFIG_KEY;
// connected, connecting, connectionError, stats and proxyIp mirror the background worker.
const state = {
  profiles: [],
  activeId: null,
  actionIconTheme: "light",
  settings: { ...DEFAULT_SETTINGS },
  connected: false,
  connecting: false,
  connectionError: "",
  stats: { upload: 0, download: 0 },
  proxyIp: null,
};
let editingId = null;
let form = blankProfile();
let statsTimer = null;
const toolbarThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

function blankProfile() {
  return {
    emoji: "🦊",
    name: "",
    protocol: "socks5",
    host: "",
    port: "",
    user: "",
    pass: "",
    activation: "all",
    patterns: "",
    pacUrl: "",
    pacBody: "",
    timezone: "proxy",
    language: "en-US",
    uaId: "current",
    uaCustom: "",
    platform: "Win32",
    resolution: "1920x1080",
    colorDepth: "24",
    pixelRatio: "1",
    touch: "0",
    hardware: "8",
    memory: "8",
    network: "wifi",
  };
}

async function loadConfig() {
  const data = await chrome.storage.local.get(CONFIG_KEY);
  const stored = data[CONFIG_KEY] || {};
  return {
    profiles: stored.profiles || [],
    activeId: stored.activeId || null,
    actionIconTheme: stored.actionIconTheme || browserToolbarTheme(),
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
  };
}

async function saveConfig() {
  await chrome.storage.local.set({
    [CONFIG_KEY]: {
      profiles: state.profiles,
      activeId: state.activeId,
      actionIconTheme: state.actionIconTheme,
      settings: state.settings,
    },
  });
}

// Persists the config and tells the worker to apply it. The worker only reconnects when the
// active profile or a connection-relevant setting changed.
async function commitConfig() {
  await saveConfig();
  await sendMessage({ type: "stateChanged" });
  await refreshLiveState();
}

async function sendMessage(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || {};
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function refreshLiveState() {
  const live = await sendMessage({ type: "getState" });
  state.connected = !!live.connected;
  state.stats = live.stats || { upload: 0, download: 0 };
  state.proxyIp = live.proxyIp || null;
}

function browserToolbarTheme() {
  return toolbarThemeQuery?.matches ? "dark" : "light";
}

async function syncActionIconTheme() {
  const actionIconTheme = browserToolbarTheme();
  if (actionIconTheme !== state.actionIconTheme) {
    state.actionIconTheme = actionIconTheme;
    await saveConfig();
  }
  await sendMessage({ type: "setActionIconTheme", theme: actionIconTheme });
}

function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes,
    i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function parseProxyString(value) {
  const s = String(value || "")
    .trim()
    .replace(/^(socks5|socks4|https?|residential):\/\//i, "");
  if (!s) return null;
  let m = s.match(/^([^:@\s]+):([^@\s]+)@(.+):(\d{1,5})$/);
  if (m) return { user: m[1], pass: m[2], host: m[3], port: m[4] };
  m = s.match(/^(.+):(\d{1,5}):([^:\s]+):(\S+)$/);
  if (m) return { host: m[1], port: m[2], user: m[3], pass: m[4] };
  m = s.match(/^(.+):(\d{1,5})$/);
  return m ? { host: m[1], port: m[2], user: "", pass: "" } : null;
}

function validateProfile(profile) {
  const port = Number(profile.port);
  if (!profile.name.trim()) return "Profile name is required.";
  if (!profile.host.trim() && profile.activation !== "pac") return "Proxy host is required.";
  if ((!Number.isInteger(port) || port < 1 || port > 65535) && profile.activation !== "pac")
    return "Port must be between 1 and 65535.";
  if (!/^(http|socks5|residential)$/.test(profile.protocol)) return "Unsupported protocol.";
  if (profile.activation === "pac" && !profile.pacUrl.trim() && !profile.pacBody.trim())
    return "PAC mode needs a PAC URL or inline PAC script.";
  return null;
}

function profileProxyLabel(profile) {
  if (!profile) return "Add or select a profile";
  if (profile.activation === "pac")
    return profile.pacUrl ? `PAC · ${profile.pacUrl}` : "PAC · inline script";
  return `${profile.protocol} · ${profile.host}:${profile.port}`;
}

function applyTheme(theme) {
  state.settings.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelectorAll("#themeToggleGroup button")
    .forEach((button) => button.classList.toggle("active", button.dataset.theme === theme));
  $("themeIcon").innerHTML =
    theme === "dark"
      ? '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
}

async function setTheme(theme) {
  applyTheme(theme);
  await commitConfig();
}

function setConnectionUi(status) {
  const map = {
    idle: ["Disconnected", "Tap orb to connect", "Idle"],
    connecting: ["Connecting…", "Negotiating tunnel", "Connecting"],
    connected: [
      "Connected",
      state.proxyIp ? `Exit IP ${state.proxyIp}` : "Checking exit IP…",
      "Online",
    ],
    error: ["Connection failed", state.connectionError || "Tap to retry", "Error"],
  };
  $("app").dataset.state = status;
  $("homeStatusValue").textContent = map[status][0];
  $("homePillText").textContent = map[status][1];
  $("topStatusText").textContent = map[status][2];
  $("statPing").textContent = status === "connected" ? "live" : "— ms";
}

function renderHome() {
  const profile = state.profiles.find((p) => p.id === state.activeId);
  $("homeActiveEmoji").textContent = profile?.emoji || "🦊";
  $("homeActiveName").textContent = profile?.name || "No profile";
  $("homeActiveHost").textContent = profileProxyLabel(profile);
  $("statUp").textContent = formatBytes(state.stats.upload);
  $("statDown").textContent = formatBytes(state.stats.download);
  setConnectionUi(state.connecting ? "connecting" : state.connected ? "connected" : "idle");
}

function renderProfiles() {
  $("profileCount").textContent = `${state.profiles.length} saved`;
  $("profileList").innerHTML = "";
  if (!state.profiles.length) {
    $("profileList").innerHTML =
      '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/></svg><p>No profiles yet.<br/>Tap <b>+ New</b> to create one.</p></div>';
    return;
  }
  for (const profile of state.profiles) {
    const activation = profile.activation || "all";
    const count = String(profile.patterns || "")
      .split(/\n+/)
      .filter(Boolean).length;
    const labels = {
      all: "All sites",
      include: `Include · ${count} rules`,
      exclude: `Exclude · ${count} rules`,
      pac: "PAC",
    };
    const card = document.createElement("div");
    card.className = `profile-card${profile.id === state.activeId ? " active" : ""}`;
    card.innerHTML = `<div class="profile-emoji">${escapeHtml(profile.emoji || "🦊")}</div><div class="profile-info"><div class="profile-name">${escapeHtml(profile.name || "Untitled")}</div><div class="profile-meta"><b>${escapeHtml(profile.protocol)}</b>${escapeHtml(profile.host || "—")}:${escapeHtml(profile.port || "")}</div><span class="profile-badge scope-${escapeHtml(activation)}">${escapeHtml(labels[activation] || labels.all)}</span></div><div class="profile-actions"><button class="icon-btn" data-act="edit" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button><button class="icon-btn" data-act="delete" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></div>`;
    card.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-act]");
      if (button?.dataset.act === "edit") return openModal(profile.id);
      if (button?.dataset.act === "delete") return deleteProfile(profile.id);
      await activateProfile(profile.id);
      navigate("home");
    });
    $("profileList").appendChild(card);
  }
}

function navigate(view) {
  document
    .querySelectorAll(".nav-item")
    .forEach((button) => button.classList.toggle("active", button.dataset.nav === view));
  document
    .querySelectorAll(".view")
    .forEach((panel) => panel.classList.toggle("active", panel.dataset.view === view));
}

function renderChips(containerId, items, key, customInputId) {
  const container = $(containerId);
  container.innerHTML = "";
  for (const [id, label] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip${form[key] === id ? " active" : ""}`;
    button.textContent = label;
    button.addEventListener("click", () => {
      form[key] = id;
      if (customInputId) $(customInputId).value = "";
      renderAllChips();
    });
    container.appendChild(button);
  }
}

function renderUaChips() {
  $("uaChipGroup").innerHTML = "";
  for (const preset of UA_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip${form.uaId === preset.id && !form.uaCustom ? " active" : ""}`;
    button.textContent = preset.label;
    button.addEventListener("click", () => {
      form.uaId = preset.id;
      form.uaCustom = "";
      $("uaCustomInput").value = "";
      renderAllChips();
    });
    $("uaChipGroup").appendChild(button);
  }
  const current =
    form.uaCustom || UA_PRESETS.find((u) => u.id === form.uaId)?.ua || navigator.userAgent;
  $("uaCurrent").textContent = current;
  $("uaActiveLabel").textContent = form.uaCustom
    ? "custom"
    : UA_PRESETS.find((u) => u.id === form.uaId)?.label.toLowerCase() || "current";
}

function renderAllChips() {
  renderUaChips();
  renderChips("platformChipGroup", PRESETS.platform, "platform", "platformCustomInput");
  renderChips("resolutionChipGroup", PRESETS.resolution, "resolution", "resolutionCustomInput");
  renderChips("languageChipGroup", PRESETS.language, "language", "languageCustomInput");
  renderChips("hardwareChipGroup", PRESETS.hardware, "hardware", "hardwareCustomInput");
  renderChips("memoryChipGroup", PRESETS.memory, "memory", "memoryCustomInput");
  renderChips("colorDepthChipGroup", PRESETS.colorDepth, "colorDepth");
  renderChips("pixelRatioChipGroup", PRESETS.pixelRatio, "pixelRatio");
  renderChips("touchChipGroup", PRESETS.touch, "touch");
  renderChips("networkChipGroup", PRESETS.network, "network");
}

function buildEmojiGrid(container, items) {
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-cell";
    button.textContent = item.e;
    button.title = item.n;
    button.addEventListener("click", () => {
      form.emoji = item.e;
      if (!$("profileNameInput").value.trim()) {
        form.name = item.n;
        $("profileNameInput").value = item.n;
      }
      $("emojiDisplay").textContent = item.e;
      $("emojiGridWrap").classList.remove("open");
      $("emojiDisplay").classList.remove("open");
    });
    container.appendChild(button);
  }
}

function updateActivationUi() {
  document
    .querySelectorAll("#activationGroup button")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.value === form.activation),
    );
  $("patternsWrap").classList.toggle(
    "open",
    form.activation === "include" || form.activation === "exclude",
  );
  $("pacWrap").classList.toggle("open", form.activation === "pac");
}

function openModal(id) {
  editingId = id || null;
  form = {
    ...blankProfile(),
    ...(id ? state.profiles.find((p) => p.id === id) : {}),
  };
  $("modalTitle").textContent = id ? "Edit profile" : "New profile";
  $("emojiDisplay").textContent = form.emoji;
  $("profileNameInput").value = form.name;
  $("quickPasteInput").value = "";
  $("hostInput").value = form.host;
  $("portInput").value = form.port;
  $("userInput").value = form.user;
  $("passInput").value = form.pass;
  $("patternsInput").value = form.patterns || "";
  $("pacUrlInput").value = form.pacUrl || "";
  $("pacBodyInput").value = form.pacBody || "";
  $("uaCustomInput").value = form.uaCustom || "";
  for (const [key, inputId] of [
    ["language", "languageCustomInput"],
    ["platform", "platformCustomInput"],
    ["resolution", "resolutionCustomInput"],
    ["hardware", "hardwareCustomInput"],
    ["memory", "memoryCustomInput"],
  ]) {
    const preset = PRESETS[key].some(([id]) => id === form[key]);
    $(inputId).value = preset ? "" : form[key];
  }
  document
    .querySelectorAll("#protocolGroup button")
    .forEach((button) => button.classList.toggle("active", button.dataset.value === form.protocol));
  document
    .querySelectorAll("#timezoneGroup button")
    .forEach((button) => button.classList.toggle("active", button.dataset.value === form.timezone));
  updateActivationUi();
  renderAllChips();
  $("profileModal").classList.add("open");
}

function closeModal() {
  $("profileModal").classList.remove("open");
}

async function saveProfile() {
  const error = validateProfile(form);
  if (error) {
    const target = !form.name.trim()
      ? $("profileNameInput")
      : !form.host.trim()
        ? $("hostInput")
        : $("portInput");
    target.classList.add("invalid");
    setTimeout(() => target.classList.remove("invalid"), 1200);
    return;
  }
  if (editingId) {
    state.profiles = state.profiles.map((p) => (p.id === editingId ? { ...p, ...form } : p));
  } else {
    const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    state.profiles.push({ id, ...form });
    if (!state.activeId) state.activeId = id;
  }
  await commitConfig();
  renderProfiles();
  renderHome();
  closeModal();
}

async function activateProfile(id) {
  state.activeId = id;
  await commitConfig();
  renderProfiles();
  renderHome();
}

async function deleteProfile(id) {
  const wasActive = state.activeId === id;
  state.profiles = state.profiles.filter((p) => p.id !== id);
  if (wasActive) {
    state.activeId = state.profiles[0]?.id || null;
    // Never silently fall back to another profile: deleting the active one disconnects.
    await saveConfig();
    await sendMessage({ type: "disconnect" });
    await refreshLiveState();
  } else {
    await commitConfig();
  }
  renderProfiles();
  renderHome();
}

async function toggleConnection() {
  if (state.connecting) return;
  const profile = state.profiles.find((p) => p.id === state.activeId);
  if (!profile) return navigate("profiles");
  if (state.connected) {
    await sendMessage({ type: "disconnect" });
    await refreshLiveState();
    state.connectionError = "";
    renderHome();
    return;
  }
  state.connecting = true;
  state.connectionError = "";
  renderHome();
  const response = await sendMessage({
    type: "connect",
    profile,
    settings: state.settings,
  });
  state.connecting = false;
  if (response.ok) {
    await refreshLiveState();
    startStatsPolling();
  } else {
    await refreshLiveState();
    state.connectionError = response.error || "Tap to retry";
    setConnectionUi("error");
    setTimeout(() => {
      state.connectionError = "";
      renderHome();
    }, 3200);
  }
  renderHome();
}

function startStatsPolling() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (!state.connected) return;
    const res = await sendMessage({ type: "getStats" });
    if (res.stats) {
      state.stats = res.stats;
      state.proxyIp = res.proxyIp || state.proxyIp;
      $("statUp").textContent = formatBytes(state.stats.upload);
      $("statDown").textContent = formatBytes(state.stats.download);
      renderHome();
    }
  }, 1000);
}

function bindInputs() {
  for (const [id, key] of [
    ["profileNameInput", "name"],
    ["hostInput", "host"],
    ["portInput", "port"],
    ["userInput", "user"],
    ["passInput", "pass"],
    ["patternsInput", "patterns"],
    ["pacUrlInput", "pacUrl"],
    ["pacBodyInput", "pacBody"],
    ["uaCustomInput", "uaCustom"],
  ]) {
    $(id).addEventListener("input", (e) => {
      form[key] =
        key === "port" || key === "host" || key === "pacUrl"
          ? e.target.value.trim()
          : e.target.value;
      if (key === "uaCustom" && form.uaCustom.trim()) {
        form.uaId = "custom";
        renderUaChips();
      }
    });
  }
  for (const [id, key] of [
    ["languageCustomInput", "language"],
    ["platformCustomInput", "platform"],
    ["resolutionCustomInput", "resolution"],
    ["hardwareCustomInput", "hardware"],
    ["memoryCustomInput", "memory"],
  ]) {
    $(id).addEventListener("input", (e) => {
      if (e.target.value.trim()) {
        form[key] = e.target.value.trim();
        renderAllChips();
      }
    });
  }
  $("quickPasteInput").addEventListener("input", (e) => {
    const parsed = parseProxyString(e.target.value);
    $("quickPasteWrap").classList.toggle("parsed", !!parsed);
    if (!parsed) return;
    Object.assign(form, parsed);
    $("hostInput").value = form.host;
    $("portInput").value = form.port;
    $("userInput").value = form.user;
    $("passInput").value = form.pass;
  });
  $("protocolGroup").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (b) {
      form.protocol = b.dataset.value;
      document
        .querySelectorAll("#protocolGroup button")
        .forEach((x) => x.classList.toggle("active", x === b));
    }
  });
  $("activationGroup").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (b) {
      form.activation = b.dataset.value;
      updateActivationUi();
    }
  });
  $("timezoneGroup").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (b) {
      form.timezone = b.dataset.value;
      document
        .querySelectorAll("#timezoneGroup button")
        .forEach((x) => x.classList.toggle("active", x === b));
    }
  });
}

function bindSettings() {
  document.querySelectorAll("[data-group]").forEach((group) => {
    const count = group.querySelectorAll(".settings-row").length;
    const badge = group.querySelector(".gh-count");
    if (badge) badge.textContent = String(count);
  });
  document
    .querySelectorAll("[data-group] .settings-group-head")
    .forEach((head) =>
      head.addEventListener("click", () => head.parentElement.classList.toggle("open")),
    );
  document.querySelectorAll(".switch[data-key]").forEach((sw) => {
    const key = sw.dataset.key;
    sw.classList.toggle("on", !!state.settings[key]);
    sw.addEventListener("click", async () => {
      state.settings[key] = !state.settings[key];
      sw.classList.toggle("on", state.settings[key]);
      await commitConfig();
    });
  });
  document.querySelectorAll(".settings-control-mini").forEach((group) => {
    const key = group.dataset.key;
    group
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", state.settings[key] === b.dataset.value));
    group.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-value]");
      if (!b) return;
      state.settings[key] = b.dataset.value;
      group.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      await commitConfig();
    });
  });
}

async function init() {
  Object.assign(state, await loadConfig());
  await refreshLiveState();
  await syncActionIconTheme();
  // Opening the popup must not notify the worker: it would be treated as a config change.
  applyTheme(state.settings.theme || "dark");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timeZone) {
    $("tzSystemLabel").textContent = `System · ${timeZone.split("/").pop().replace(/_/g, " ")}`;
  }
  $("aboutVersion").textContent = `OpenFoxy · v${chrome.runtime.getManifest().version}`;
  buildEmojiGrid($("emojiGridFlags"), EMOJI_FLAGS);
  buildEmojiGrid($("emojiGridAnimals"), EMOJI_ANIMALS);
  buildEmojiGrid($("emojiGridObjects"), EMOJI_OBJECTS);
  bindInputs();
  bindSettings();
  document
    .querySelectorAll(".nav-item")
    .forEach((b) => b.addEventListener("click", () => navigate(b.dataset.nav)));
  $("themeQuickToggle").addEventListener("click", () =>
    setTheme(state.settings.theme === "dark" ? "light" : "dark"),
  );
  $("themeToggleGroup").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-theme]");
    if (b) setTheme(b.dataset.theme);
  });
  toolbarThemeQuery?.addEventListener?.("change", syncActionIconTheme);
  $("homeChangeBtn").addEventListener("click", () => navigate("profiles"));
  $("connectOrb").addEventListener("click", toggleConnection);
  $("addProfileBtn").addEventListener("click", () => openModal());
  $("cancelBtn").addEventListener("click", closeModal);
  $("closeModalBtn").addEventListener("click", closeModal);
  $("saveBtn").addEventListener("click", saveProfile);
  $("emojiDisplay").addEventListener("click", () => {
    const open = $("emojiGridWrap").classList.toggle("open");
    $("emojiDisplay").classList.toggle("open", open);
  });
  $("customEmojiApply").addEventListener("click", () => {
    const value = $("customEmojiInput").value.trim();
    if (value) {
      form.emoji = value;
      $("emojiDisplay").textContent = value;
      $("customEmojiInput").value = "";
      $("emojiGridWrap").classList.remove("open");
    }
  });
  renderProfiles();
  renderHome();
  if (state.connected) startStatsPolling();
}

init();
