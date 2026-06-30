#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const os = require("os");

// -----------------------------------------------------------------
// 🛠️ CLI PARSING & CONFIG
// -----------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const args = [];
const flags = { country: null, limit: null, gateway: 9000 };
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(`${__dirname}/package.json`, "utf8")).version;
  } catch (e) {
    return "0.0.0";
  }
})();

if (typeof module !== "undefined") {
  module.exports = { parseBytes, formatBytes, parsePortStrict };
}

for (let i = 1; i < rawArgs.length; i++) {
  if (rawArgs[i].startsWith("--country=")) flags.country = rawArgs[i].split("=")[1].toUpperCase();
  else if (rawArgs[i].startsWith("--limit=")) flags.limit = parseBytes(rawArgs[i].split("=")[1]);
  else if (rawArgs[i].startsWith("--gateway=")) flags.gateway = rawArgs[i].split("=")[1];
  else args.push(rawArgs[i]);
}

const SUPPORTED_PROTOCOLS = new Set(["http", "socks5", "mtproto", "residential"]);

const run = (cmd, showOutput = true) => execSync(cmd, { stdio: showOutput ? "inherit" : "ignore" });
const runQuiet = (cmd) => {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
};

const rule = (width = 58) => "═".repeat(width);

if (["--version", "-v", "version"].includes(command)) {
  console.log(PACKAGE_VERSION);
  process.exit(0);
}

function printHelp() {
  console.log("\n\ud83e\udd8a OpenFoxy \u2014 Distributed Proxy Manager v" + PACKAGE_VERSION);
  console.log(rule() + "\n");
  console.log("Usage:");
  console.log("  npx openfoxy --help | -h");
  console.log("  npx openfoxy --version | -v");
  console.log("  npx openfoxy add <user> <pass> <port> [protocol] [--country=US] [--limit=2GB]");
  console.log("  npx openfoxy change <user> [newpass] [--limit=XGB] [--country=XX]");
  console.log("  npx openfoxy delete <user> <port>");
  console.log("  npx openfoxy list                        Show active proxies");
  console.log("  npx openfoxy status                      Analytics (traffic, providers, limits)");
  console.log("  npx openfoxy stop [port|protocol]        Stop specific or all services");
  console.log("  npx openfoxy start [port|protocol]       Start specific or all services");
  console.log("  npx openfoxy uninstall                   Remove everything");
  console.log();
  console.log("Protocols:");
  console.log("  http        Standard web proxy (Squid)");
  console.log("  socks5      TCP proxy via Dante");
  console.log("  mtproto     Telegram proxy via MTG");
  console.log("  residential Distributed relay through Home PCs");
  console.log();
  console.log("Residential Network:");
  console.log("  npx openfoxy provider <vps-ip>:<gateway-port>:<token> [--quiet]");
  console.log("  npx openfoxy providers                           List / manage providers");
  console.log("  npx openfoxy providers block <ip> [reason]");
  console.log("  npx openfoxy providers unblock <ip>");
  console.log("  npx openfoxy providers whitelist <ip>");
  console.log("  npx openfoxy providers unwhitelist <ip>");
  console.log();
  console.log("Docker:");
  console.log(
    "  docker run -d -p <port>:<port> ghcr.io/maxylev/openfoxy:latest <user> <pass> <port> [protocol]",
  );
  console.log();
}

if (["--help", "-h", "help"].includes(command)) {
  printHelp();
  process.exit(0);
}

const requiresRoot = ["add", "delete", "change", "stop", "start", "uninstall", "serve-master"];
if (requiresRoot.includes(command) && process.getuid && process.getuid() !== 0) {
  console.error("\n\u274c Error: Please run OpenFoxy with sudo/root privileges.\n");
  process.exit(1);
}

const DB_PATH = "/etc/openfoxy.json";
const STATE_PATH = "/var/run/openfoxy_state.json";
const BLACKLIST_PATH = "/etc/openfoxy_blacklist.json";
const WHITELIST_PATH = "/etc/openfoxy_whitelist.json";
const TRAFFIC_PATH = "/var/lib/openfoxy/traffic.json";

let db = { proxies: [] };
try {
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
} catch (e) {}

function writeJsonSecure(path, value) {
  const tmpPath = `${path}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, path);
}

const saveDb = () => writeJsonSecure(DB_PATH, db);

function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_PATH)) return JSON.parse(fs.readFileSync(BLACKLIST_PATH, "utf8"));
  } catch (e) {}
  return {};
}

function saveBlacklist(list) {
  try {
    writeJsonSecure(BLACKLIST_PATH, list);
  } catch (e) {}
}

function loadWhitelist() {
  try {
    if (fs.existsSync(WHITELIST_PATH)) return JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"));
  } catch (e) {}
  return [];
}

function saveWhitelist(list) {
  try {
    writeJsonSecure(WHITELIST_PATH, list);
  } catch (e) {}
}

// -----------------------------------------------------------------
// 🌐 UTILITIES & IP TRACKING
// -----------------------------------------------------------------
function parseBytes(str) {
  const match = str.match(/^(\d+(?:\.\d+)?)([KMG]B?)$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit.startsWith("K")) return val * 1024;
  if (unit.startsWith("M")) return val * 1024 * 1024;
  if (unit.startsWith("G")) return val * 1024 * 1024 * 1024;
  return val;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024,
    dm = 2,
    sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

function progressBar(used, total, width) {
  if (!total) return "";
  width = width || 20;
  var pct = Math.min(used / total, 1);
  var filled = Math.round(pct * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function getProxyHealth(proxy) {
  if (!proxy.limit) return "active";
  var traffic = trackTraffic(proxy.port);
  var usage = traffic.rx + traffic.tx;
  if (usage >= proxy.limit) return "exhausted";
  if (usage >= proxy.limit * 0.8) return "warning";
  return "active";
}

function formatTimestamp(iso) {
  try {
    var d = new Date(iso);
    var months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return (
      months[d.getUTCMonth()] +
      " " +
      d.getUTCDate() +
      " " +
      String(d.getUTCHours()).padStart(2, "0") +
      ":" +
      String(d.getUTCMinutes()).padStart(2, "0") +
      " UTC"
    );
  } catch (e) {
    return iso;
  }
}

function validateUser(user) {
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) {
    console.error("\n\u274c Invalid username. Only letters, numbers, underscores, and hyphens.\n");
    process.exit(1);
  }
}

function parsePortStrict(port) {
  const raw = String(port ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function validatePort(port) {
  const p = parsePortStrict(port);
  if (p === null) {
    console.error("\n\u274c Invalid port. Must be between 1 and 65535.\n");
    process.exit(1);
  }
  return p;
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function validateProtocol(protocol) {
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    console.error("\n❌ Invalid protocol. Use http, socks5, mtproto, or residential.\n");
    process.exit(1);
  }
}

function validateLimitFlag(limit, rawLimit) {
  if (rawLimit && limit === null && rawLimit !== "0" && rawLimit.toLowerCase() !== "none") {
    console.error("\n❌ Invalid limit. Use values like 500MB, 2GB, or 0/none when changing.\n");
    process.exit(1);
  }
}

async function getPublicIp() {
  const providers = ["https://icanhazip.com", "https://ifconfig.me", "https://ipinfo.io/ip"];
  for (const url of providers) {
    try {
      const ip = await new Promise((res, rej) => {
        const req = https.get(url, { timeout: 2500 }, (r) => {
          let d = "";
          r.on("data", (c) => (d += c));
          r.on("end", () => res(d.trim()));
        });
        req.on("error", rej);
        req.on("timeout", () => {
          req.destroy();
          rej("timeout");
        });
      });
      if (/^[\d\.]+$/.test(ip)) return ip;
    } catch (e) {
      continue;
    }
  }
  return "YOUR_SERVER_IP";
}

const ipTokens = [
  "223469161b4d4b",
  "11d71a12a4c8ac",
  "cf2feb5555f627",
  "cf4c724a75a7ee",
  "4adfcc46c95c4a",
  "416c3b42e5cc10",
];
function getIpInfo(ip) {
  const token = ipTokens[Math.floor(Math.random() * ipTokens.length)];
  return new Promise((resolve) => {
    https
      .get(`https://api.ipinfo.io/lite/${ip}?token=${token}`, { timeout: 3000 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({});
          }
        });
      })
      .on("error", () => resolve({}));
  });
}

// -----------------------------------------------------------------
// 🐧 OS ABSTRACTION & KERNEL FIREWALL
// -----------------------------------------------------------------
function detectOS() {
  if (process.platform !== "linux" || !fs.existsSync("/etc/os-release")) return null;
  const osRelease = fs.readFileSync("/etc/os-release", "utf8").toLowerCase();

  const isAlpine = osRelease.includes("alpine");
  const isDebian = osRelease.includes("debian") || osRelease.includes("ubuntu");
  const isRhel =
    osRelease.includes("centos") ||
    osRelease.includes("rhel") ||
    osRelease.includes("rocky") ||
    osRelease.includes("almalinux");

  return {
    isAlpine,
    isDebian,
    isRhel,
    install: (pkgs) => {
      if (isAlpine) run(`apk update && apk add --no-cache iptables ${pkgs}`);
      else if (isDebian)
        run(`apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y iptables ${pkgs}`);
      else
        run(
          `dnf install -y epel-release iptables 2>/dev/null || yum install -y epel-release iptables 2>/dev/null || true; dnf install -y ${pkgs} || yum install -y ${pkgs}`,
        );
    },
    service: (action, name) => {
      if (fs.existsSync("/etc/systemd/system") || runQuiet("command -v systemctl")) {
        runQuiet(`systemctl ${action} ${name} 2>/dev/null || true`);
      } else if (isAlpine || fs.existsSync("/sbin/openrc-run")) {
        runQuiet(`rc-service ${name} ${action} 2>/dev/null || true`);
      }
    },
    isServiceRunning: (name) => {
      if (fs.existsSync("/etc/systemd/system") || runQuiet("command -v systemctl")) {
        return runQuiet(`systemctl is-active --quiet ${name}`);
      } else {
        return runQuiet(`rc-service ${name} status | grep -q 'started'`);
      }
    },
    daemonize: (name, execCmd) => {
      if (fs.existsSync("/etc/systemd/system") || runQuiet("command -v systemctl")) {
        const svc = `[Unit]\nDescription=OpenFoxy ${name}\nAfter=network.target\n[Service]\nExecStart=${execCmd}\nRestart=always\nLimitNOFILE=65535\n[Install]\nWantedBy=multi-user.target`;
        fs.writeFileSync(`/etc/systemd/system/${name}.service`, svc);
        runQuiet(
          `systemctl daemon-reload && systemctl enable ${name} && systemctl restart ${name}`,
        );
      } else if (fs.existsSync("/etc/init.d")) {
        const svcPath = `/etc/init.d/${name}`;
        const svc = `#!/sbin/openrc-run\nname="${name}"\ncommand="${execCmd.split(" ")[0]}"\ncommand_args="${execCmd.substring(execCmd.indexOf(" ") + 1)}"\ncommand_background="yes"\npidfile="/run/${name}.pid"\n`;
        fs.writeFileSync(svcPath, svc);
        runQuiet(
          `chmod +x ${svcPath} && rc-update add ${name} default && rc-service ${name} restart`,
        );
      }
    },
  };
}

function getExternalInterface() {
  try {
    const ifaces = os.networkInterfaces();
    return (
      Object.keys(ifaces).find(
        (k) => k !== "lo" && !k.startsWith("docker") && !k.startsWith("br-"),
      ) || "eth0"
    );
  } catch (e) {
    return "eth0";
  }
}

function writeDanteConfig(osInfo, socksProxies) {
  const confPath = osInfo.isDebian ? "/etc/danted.conf" : "/etc/sockd.conf";
  const extIf = getExternalInterface();
  const internals = socksProxies
    .map((p) => `internal: 0.0.0.0 port = ${parsePortStrict(p.port)}`)
    .join("\n");
  fs.writeFileSync(
    confPath,
    `logoutput: syslog\n${internals}\nexternal: ${extIf}\nsocksmethod: username\nclientmethod: none\nuser.privileged: root\nuser.unprivileged: nobody\nclient pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }\nsocks pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }\n`,
  );
}

function configureFirewall(port, osInfo, remove = false) {
  try {
    if (!remove) {
      if (osInfo.isDebian) runQuiet(`ufw allow ${port}/tcp`);
      if (osInfo.isRhel)
        runQuiet(`firewall-cmd --permanent --add-port=${port}/tcp && firewall-cmd --reload`);
      if (!runQuiet(`iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null`))
        runQuiet(`iptables -I INPUT 1 -p tcp --dport ${port} -j ACCEPT`);
      if (!runQuiet(`iptables -C OUTPUT -p tcp --sport ${port} -j ACCEPT 2>/dev/null`))
        runQuiet(`iptables -I OUTPUT 1 -p tcp --sport ${port} -j ACCEPT`);
    } else {
      if (osInfo.isDebian) runQuiet(`ufw delete allow ${port}/tcp`);
      if (osInfo.isRhel)
        runQuiet(`firewall-cmd --permanent --remove-port=${port}/tcp && firewall-cmd --reload`);
      runQuiet(`iptables -D INPUT -p tcp --dport ${port} -j ACCEPT`);
      runQuiet(`iptables -D OUTPUT -p tcp --sport ${port} -j ACCEPT`);
    }
  } catch (e) {}
}

const portTraffic = new Map();

function trackPortRx(port, bytes) {
  if (!portTraffic.has(port)) portTraffic.set(port, { rx: 0, tx: 0 });
  portTraffic.get(port).rx += bytes;
}

function trackPortTx(port, bytes) {
  if (!portTraffic.has(port)) portTraffic.set(port, { rx: 0, tx: 0 });
  portTraffic.get(port).tx += bytes;
}

function getPortTraffic(port) {
  return portTraffic.get(port) || { rx: 0, tx: 0 };
}

function trackTraffic(port) {
  let rx = 0,
    tx = 0;
  try {
    const i = execSync(`iptables -nxvL INPUT | grep -w "dpt:${port}" | head -n 1 || true`, {
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (i) rx = parseInt(i.split(/\s+/)[1]) || 0;
    const o = execSync(`iptables -nxvL OUTPUT | grep -w "spt:${port}" | head -n 1 || true`, {
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (o) tx = parseInt(o.split(/\s+/)[1]) || 0;
  } catch (e) {}
  const appData = getPortTraffic(port);
  let fileData = { rx: 0, tx: 0 };
  try {
    if (fs.existsSync(TRAFFIC_PATH)) {
      const all = JSON.parse(fs.readFileSync(TRAFFIC_PATH, "utf8"));
      if (all[port]) fileData = all[port];
    }
  } catch (e) {}
  rx = Math.max(rx, appData.rx, fileData.rx);
  tx = Math.max(tx, appData.tx, fileData.tx);
  return { rx, tx };
}

// -----------------------------------------------------------------
// 🏠 RESIDENTIAL RELAY NETWORK (Daemon)
// -----------------------------------------------------------------
function serveResidentialMaster(gatewayPort) {
  gatewayPort = gatewayPort || 9000;
  console.log(`🚀 Starting Master Residential Daemon on port ${gatewayPort}...`);
  let providers = [];
  const consumerServers = new Map();
  const providerErrors = new Map();
  function loadTrafficFromFile() {
    try {
      if (fs.existsSync(TRAFFIC_PATH)) {
        const data = JSON.parse(fs.readFileSync(TRAFFIC_PATH, "utf8"));
        for (const [k, v] of Object.entries(data)) {
          portTraffic.set(parseInt(k), v);
        }
      }
    } catch (e) {}
  }

  function syncTrafficToFile() {
    try {
      const dir = "/var/lib/openfoxy";
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {};
      portTraffic.forEach((v, k) => {
        data[k] = v;
      });
      writeJsonSecure(TRAFFIC_PATH, data);
    } catch (e) {}
  }

  const AUTO_BLACKLIST_THRESHOLD = 5;
  const AUTO_BLACKLIST_WINDOW = 600000;

  function ensureResidentialTokens(currentDb) {
    let changed = false;
    currentDb.proxies.forEach((p) => {
      if (p.type === "residential" && !p.providerToken) {
        p.providerToken = crypto.randomBytes(18).toString("base64url");
        changed = true;
      }
    });
    if (changed) {
      db = currentDb;
      saveDb();
    }
    return currentDb.proxies
      .filter((p) => p.type === "residential" && p.providerToken)
      .map((p) => p.providerToken);
  }

  function providerTokenAllowed(token) {
    try {
      const currentDb = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      ensureResidentialTokens(currentDb);
      return ensureResidentialTokens(currentDb).includes(token);
    } catch (e) {
      return false;
    }
  }

  function isIpAllowed(ip) {
    const blacklist = loadBlacklist();
    if (blacklist[ip]) return false;
    const whitelist = loadWhitelist();
    if (whitelist.length > 0 && !whitelist.includes(ip)) return false;
    return true;
  }

  function recordError(ip) {
    const now = Date.now();
    let record = providerErrors.get(ip);
    if (!record || now - record.firstAt > AUTO_BLACKLIST_WINDOW) {
      record = { count: 0, firstAt: now };
      providerErrors.set(ip, record);
    }
    record.count++;
    if (record.count >= AUTO_BLACKLIST_THRESHOLD) {
      const blacklist = loadBlacklist();
      if (!blacklist[ip]) {
        blacklist[ip] = { reason: "auto", at: new Date().toISOString() };
        saveBlacklist(blacklist);
        providers.filter((p) => p.ipRaw === ip).forEach((p) => p.destroy());
        console.log(`⚠️  Auto-blacklisted provider ${ip} (${record.count} abrupt disconnects)`);
      }
    }
  }

  function syncStateToFile() {
    const state = providers.map((p) => ({
      id: p.providerId,
      ip: p.ipRaw,
      country: p.country,
      rx: p.rxBytes,
      tx: p.txBytes,
      connectedAt: p.connectedAt,
    }));
    try {
      writeJsonSecure(STATE_PATH, state);
    } catch (e) {}
  }

  function syncServers() {
    try {
      const currentDb = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      const resProxies = currentDb.proxies.filter((p) => p.type === "residential");

      consumerServers.forEach((server, port) => {
        const conf = resProxies.find((p) => p.port == port);
        const traffic = trackTraffic(port);
        if (!conf || (conf.limit && traffic.rx + traffic.tx >= conf.limit)) {
          server.close();
          consumerServers.delete(port);
        }
      });

      resProxies.forEach((proxy) => {
        if (!consumerServers.has(proxy.port)) {
          const traffic = trackTraffic(proxy.port);
          if (proxy.limit && traffic.rx + traffic.tx >= proxy.limit) return;
          const server = net.createServer((socket) => handleConsumer(socket, proxy));
          server.on("error", () => {});
          server.listen(proxy.port, "0.0.0.0");
          consumerServers.set(proxy.port, server);
        }
      });
    } catch (e) {}
    syncTrafficToFile();
    syncStateToFile();
  }

  loadTrafficFromFile();

  setInterval(syncServers, 10000);
  syncServers();

  setInterval(() => {
    const blacklist = loadBlacklist();
    if (Object.keys(blacklist).length > 0) {
      providers.forEach((p) => {
        if (blacklist[p.ipRaw]) p.destroy();
      });
    }
  }, 1000);

  const gateway = net.createServer((socket) => {
    socket.rxBytes = 0;
    socket.txBytes = 0;

    // Override write to track outward traffic efficiently
    const originalWrite = socket.write;
    socket.write = function (chunk, ...args) {
      if (chunk) socket.txBytes += chunk.length;
      return originalWrite.apply(this, [chunk, ...args]);
    };

    socket.once("data", async (data) => {
      socket.rxBytes += data.length;
      const authHeader = data.toString("utf8", 0, 256).split("\n")[0];
      const token = authHeader.match(/^PROVIDER\s+(.+)$/)?.[1]?.trim();
      if (!token || !providerTokenAllowed(token)) return socket.destroy();

      socket.ipRaw = socket.remoteAddress.replace(/^.*:/, "");
      if (!isIpAllowed(socket.ipRaw)) return socket.destroy();

      const ipInfo = await getIpInfo(socket.ipRaw);
      socket.country = ipInfo.country_code || "UNKNOWN";
      socket.providerId = crypto.randomBytes(4).toString("hex");
      socket.connectedAt = new Date().toISOString();
      socket.targets = new Map();
      socket.graceful = false;

      providers.push(socket);
      syncStateToFile();

      let buffer = "";
      socket.on("data", (chunk) => {
        socket.rxBytes += chunk.length;
        buffer += chunk.toString("utf8");
        let lines = buffer.split("\n");
        buffer = lines.pop();
        for (let line of lines) {
          if (!line) continue;
          if (line === "GRACEFUL_DISCONNECT") {
            socket.graceful = true;
            socket.destroy();
            return;
          }
          try {
            const msg = JSON.parse(line);
            const target = socket.targets.get(msg.id);
            if (!target) continue;
            if (msg.type === "data") target.write(Buffer.from(msg.data, "base64"));
            else if (msg.type === "close") {
              target.destroy();
              socket.targets.delete(msg.id);
            }
          } catch (e) {}
        }
      });

      const cleanup = () => {
        if (socket.cleanedUp) return;
        socket.cleanedUp = true;
        providers = providers.filter((p) => p !== socket);
        socket.targets.forEach((t) => t.destroy());
        socket.targets.clear();
        syncStateToFile();
        if (!socket.graceful && socket.ipRaw) recordError(socket.ipRaw);
      };

      socket.on("error", cleanup);
      socket.on("close", cleanup);
    });
  });

  gateway.on("error", () => {});
  gateway.listen(gatewayPort, "0.0.0.0");

  function relayToProvider(socket, provider, proxyConf, host, port, initialData) {
    const id = crypto.randomBytes(4).toString("hex");
    provider.targets.set(id, socket);

    try {
      provider.write(JSON.stringify({ type: "connect", id, host, port }) + "\n");
      if (initialData) {
        provider.write(
          JSON.stringify({
            type: "data",
            id,
            data: Buffer.from(initialData).toString("base64"),
          }) + "\n",
        );
      }
    } catch (e) {
      return socket.destroy();
    }

    socket.on("data", (chunk) => {
      try {
        provider.write(
          JSON.stringify({
            type: "data",
            id,
            data: chunk.toString("base64"),
          }) + "\n",
        );
      } catch (e) {
        socket.destroy();
      }
    });

    const closeDown = () => {
      try {
        provider.write(JSON.stringify({ type: "close", id }) + "\n");
      } catch (e) {}
      provider.targets.delete(id);
      socket.destroy();
    };

    socket.on("error", closeDown);
    socket.on("close", closeDown);
  }

  function pickProvider(proxyConf) {
    let validProviders = proxyConf.country
      ? providers.filter((p) => p.country === proxyConf.country)
      : providers;
    if (validProviders.length === 0) return null;
    return validProviders[Math.floor(Math.random() * validProviders.length)];
  }

  function handleConsumer(socket, proxyConf) {
    try {
      var currentDb = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      var fresh = currentDb.proxies.find(function (p) {
        return p.port == proxyConf.port;
      });
      if (fresh) proxyConf = fresh;
    } catch (e) {}

    var consumerPort = proxyConf.port;

    socket.on("data", (chunk) => {
      trackPortRx(consumerPort, chunk.length);
    });

    const origWrite = socket.write.bind(socket);
    socket.write = function (data, ...args) {
      if (data) {
        const len = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
        trackPortTx(consumerPort, len);
      }
      return origWrite(data, ...args);
    };

    socket.once("data", (firstChunk) => {
      if (firstChunk[0] === 0x05) {
        handleSOCKS5(socket, proxyConf, firstChunk);
      } else {
        handleHTTPConnect(socket, proxyConf, firstChunk);
      }
    });
    socket.on("error", () => socket.destroy());
  }

  function handleSOCKS5(socket, proxyConf, greeting) {
    if (greeting.length < 3) return socket.destroy();

    const nMethods = greeting[1];
    const methods = new Set();
    for (let i = 0; i < nMethods && 2 + i < greeting.length; i++) methods.add(greeting[2 + i]);

    if (!methods.has(0x02)) {
      socket.write(Buffer.from([0x05, 0xff]));
      return socket.destroy();
    }

    socket.write(Buffer.from([0x05, 0x02]));

    socket.once("data", (authData) => {
      if (authData[0] !== 0x01 || authData.length < 4) {
        socket.write(Buffer.from([0x01, 0x01]));
        return socket.destroy();
      }

      const ulen = authData[1];
      const uname = authData.slice(2, 2 + ulen).toString();
      const plen = authData[2 + ulen];
      const passwd = authData.slice(3 + ulen, 3 + ulen + plen).toString();

      if (uname !== proxyConf.user || passwd !== proxyConf.pass) {
        socket.write(Buffer.from([0x01, 0x01]));
        return socket.destroy();
      }

      socket.write(Buffer.from([0x01, 0x00]));

      const provider = pickProvider(proxyConf);
      if (!provider) return socket.destroy();

      socket.once("data", (connData) => {
        if (connData[0] !== 0x05 || connData[1] !== 0x01) return socket.destroy();

        let host = "",
          offset = 4;
        if (connData[3] === 0x01) {
          host = connData.slice(4, 8).join(".");
          offset = 8;
        } else if (connData[3] === 0x03) {
          const len = connData[4];
          host = connData.slice(5, 5 + len).toString();
          offset = 5 + len;
        } else return socket.destroy();

        const targetPort = connData.readUInt16BE(offset);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        relayToProvider(socket, provider, proxyConf, host, targetPort);
      });
    });
  }

  function handleHTTPConnect(socket, proxyConf, firstChunk) {
    const header = firstChunk.toString("utf8");
    const headerEnd =
      header.indexOf("\r\n\r\n") >= 0
        ? header.indexOf("\r\n\r\n") + 4
        : header.indexOf("\n\n") >= 0
          ? header.indexOf("\n\n") + 2
          : firstChunk.length;
    const headText = firstChunk.toString("utf8", 0, headerEnd);
    const connectMatch = headText.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]\r?\n/i);
    const plainMatch = headText.match(
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/[^\s]+)\s+(HTTP\/1\.[01])\r?\n/i,
    );
    if (!connectMatch && !plainMatch) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      return socket.destroy();
    }

    let host,
      port,
      initialData = null;
    if (connectMatch) {
      host = connectMatch[1];
      port = parseInt(connectMatch[2]);
    } else {
      const target = new URL(plainMatch[2]);
      host = target.hostname;
      port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
      const path = `${target.pathname || "/"}${target.search || ""}`;
      const rewritten = headText
        .replace(plainMatch[0], `${plainMatch[1]} ${path} ${plainMatch[3]}\r\n`)
        .replace(/^Proxy-Authorization:.*\r?\n/im, "");
      initialData = Buffer.concat([Buffer.from(rewritten), firstChunk.slice(headerEnd)]);
    }

    let authHeader = "";
    const lines = header.split(/\r?\n/);
    for (const line of lines) {
      if (line.toLowerCase().startsWith("proxy-authorization:")) {
        authHeader = line.substring(line.indexOf(":") + 1).trim();
        break;
      }
    }

    if (!authHeader.startsWith("Basic ")) {
      socket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="openfoxy"\r\n\r\n',
      );
      return socket.destroy();
    }

    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) {
      socket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="openfoxy"\r\n\r\n',
      );
      return socket.destroy();
    }

    const uname = decoded.substring(0, colonIdx);
    const passwd = decoded.substring(colonIdx + 1);

    if (uname !== proxyConf.user || passwd !== proxyConf.pass) {
      socket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="openfoxy"\r\n\r\n',
      );
      return socket.destroy();
    }

    const provider = pickProvider(proxyConf);
    if (!provider) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return socket.destroy();
    }

    if (connectMatch) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    relayToProvider(socket, provider, proxyConf, host, parseInt(port), initialData);
  }
}

// -----------------------------------------------------------------
// 🔌 PROVIDER CLIENT (Home PC Exit Node)
// -----------------------------------------------------------------
function runProviderClient(host, port, token, quiet) {
  let targets = new Map();
  let activeSocket = null;

  function log(msg) {
    if (!quiet) console.log(msg);
  }

  function gracefulShutdown() {
    if (activeSocket && !activeSocket.destroyed) {
      try {
        activeSocket.write("GRACEFUL_DISCONNECT\n");
      } catch (e) {}
    }
    setTimeout(() => process.exit(0), 500);
  }

  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  function connect() {
    log(`\n⏳ Connecting to Master Gateway at ${host}:${port}...`);
    const ws = net.createConnection({ host, port }, () => {
      log("✅ Connected! Proxying traffic globally...");
      ws.write("PROVIDER " + token + "\n");
    });
    activeSocket = ws;

    let buffer = "";
    ws.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let lines = buffer.split("\n");
      buffer = lines.pop();
      for (let line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "connect") {
            const target = net.createConnection({
              host: msg.host,
              port: msg.port,
            });
            target.on("data", (data) => {
              try {
                ws.write(
                  JSON.stringify({
                    type: "data",
                    id: msg.id,
                    data: data.toString("base64"),
                  }) + "\n",
                );
              } catch (e) {}
            });
            const closeTarget = () => {
              try {
                ws.write(JSON.stringify({ type: "close", id: msg.id }) + "\n");
              } catch (e) {}
              targets.delete(msg.id);
            };
            target.on("error", closeTarget);
            target.on("close", closeTarget);
            targets.set(msg.id, target);
          } else if (msg.type === "data" && targets.has(msg.id)) {
            targets.get(msg.id).write(Buffer.from(msg.data, "base64"));
          } else if (msg.type === "close" && targets.has(msg.id)) {
            targets.get(msg.id).destroy();
            targets.delete(msg.id);
          }
        } catch (e) {}
      }
    });

    ws.on("close", () => {
      log("❌ Disconnected. Reconnecting in 3s...");
      targets.forEach((t) => t.destroy());
      targets.clear();
      setTimeout(connect, 3000);
    });
    ws.on("error", () => {});
  }
  connect();
}

// -----------------------------------------------------------------
// 🚀 MAIN CLI ROUTER
// -----------------------------------------------------------------
(async () => {
  const osInfo = detectOS();

  try {
    switch (command) {
      case "serve-master":
        serveResidentialMaster(parseInt(args[0]) || 9000);
        break;

      case "provider": {
        const pQuiet = args.includes("--quiet");
        const pArgs = args.filter((a) => a !== "--quiet");
        let pIp, pPort, pToken;
        if (pArgs.length === 1 && pArgs[0].includes(":")) {
          [pIp, pPort, pToken] = pArgs[0].split(":");
        } else if (pArgs.length === 2 && pArgs[0].includes(":")) {
          [pIp, pPort] = pArgs[0].split(":");
          pToken = pArgs[1];
        } else if (pArgs.length === 3) {
          [pIp, pPort, pToken] = pArgs;
        } else {
          return console.log("\n\u274c Usage: openfoxy provider <ip>:<port>:<token> [--quiet]\n");
        }
        const providerPort = validatePort(pPort);
        if (!pToken) {
          return console.log(
            "\n\u274c Provider token is required. Copy the full Provider command from 'openfoxy add ... residential'.\n",
          );
        }
        runProviderClient(pIp, providerPort, pToken, pQuiet);
        break;
      }

      case "providers": {
        const sub = args[0];
        if (sub === "block") {
          const ip = args[1];
          if (!ip) return console.log("\n\u274c Usage: openfoxy providers block <ip>\n");
          const list = loadBlacklist();
          list[ip] = {
            reason: args.slice(2).join(" ") || "manual",
            at: new Date().toISOString(),
          };
          saveBlacklist(list);
          console.log("\n\u2705 Blocked provider " + ip + ".\n");
        } else if (sub === "unblock") {
          const ip = args[1];
          if (!ip) return console.log("\n\u274c Usage: openfoxy providers unblock <ip>\n");
          const list = loadBlacklist();
          delete list[ip];
          saveBlacklist(list);
          console.log("\n\u2705 Unblocked provider " + ip + ".\n");
        } else if (sub === "whitelist") {
          const ip = args[1];
          if (!ip) return console.log("\n\u274c Usage: openfoxy providers whitelist <ip>\n");
          const list = loadWhitelist();
          if (!list.includes(ip)) list.push(ip);
          saveWhitelist(list);
          console.log("\n\u2705 Added " + ip + " to whitelist.\n");
        } else if (sub === "unwhitelist") {
          const ip = args[1];
          if (!ip) return console.log("\n\u274c Usage: openfoxy providers unwhitelist <ip>\n");
          const list = loadWhitelist().filter((i) => i !== ip);
          saveWhitelist(list);
          console.log("\n\u2705 Removed " + ip + " from whitelist.\n");
        } else {
          let resState = [];
          try {
            resState = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
          } catch (e) {}
          const blacklist = loadBlacklist();
          const whitelist = loadWhitelist();

          console.log("\n\ud83c\udfe0 Provider Management");
          console.log(rule(55));

          if (resState.length > 0) {
            console.log("\n\ud83d\udfe2 Connected (" + resState.length + "):");
            resState.forEach(function (p) {
              console.log(
                "   \u2514\u2500 " +
                  p.ip +
                  " [" +
                  p.country +
                  "] \u2014 since " +
                  formatTimestamp(p.connectedAt),
              );
            });
          } else {
            console.log("\n\ud83d\udd34 No providers connected.");
          }

          var blEntries = Object.entries(blacklist);
          if (blEntries.length > 0) {
            console.log("\n\ud83d\udeab Blacklisted (" + blEntries.length + "):");
            blEntries.forEach(function (entry) {
              console.log(
                "   \u2514\u2500 " +
                  entry[0] +
                  " \u2014 " +
                  entry[1].reason +
                  " (" +
                  formatTimestamp(entry[1].at) +
                  ")",
              );
            });
          }

          if (whitelist.length > 0) {
            console.log("\n\u2705 Whitelist (" + whitelist.length + "):");
            whitelist.forEach(function (ip) {
              console.log("   \u2514\u2500 " + ip);
            });
          }

          console.log("\n" + rule(55) + "\n");
        }
        break;
      }

      case "add": {
        if (!osInfo)
          return console.error(
            "\n\u274c Unsupported OS. Requires Debian/Ubuntu, RHEL/CentOS, or Alpine.\n",
          );
        let [user, pass, port, requestedProto] = args;
        if (!user || !pass || !port)
          return console.log("\n\u274c Usage: openfoxy add <user> <pass> <port> [protocol]\n");

        validateUser(user);
        port = validatePort(port);

        const protocol = (requestedProto || "http").toLowerCase();
        validateProtocol(protocol);
        flags.gateway = validatePort(flags.gateway);
        validateLimitFlag(
          flags.limit,
          rawArgs.find(function (a) {
            return a.startsWith("--limit=");
          }),
        );
        console.log(
          "\n\ud83d\ude80 Deploying " +
            protocol.toUpperCase() +
            " Proxy \u2192 Port " +
            port +
            "...\n",
        );

        if (protocol === "http") {
          osInfo.install(
            osInfo.isDebian
              ? "squid apache2-utils ufw"
              : osInfo.isAlpine
                ? "squid apache2-utils"
                : "squid httpd-tools firewalld",
          );
          run(`mkdir -p /etc/squid && touch /etc/squid/passwords`);
          run(`htpasswd -b /etc/squid/passwords ${shellEscape(user)} ${shellEscape(pass)}`);

          const setupAuth = `AUTH_PATH=$(find /usr/lib/squid /usr/lib64/squid /usr/libexec/squid -name basic_ncsa_auth 2>/dev/null | head -n 1)\ncat <<EOF > /etc/squid/squid.conf\nauth_param basic program $AUTH_PATH /etc/squid/passwords\nacl authenticated proxy_auth REQUIRED\nhttp_access allow authenticated\nhttp_access deny all\nEOF`;
          run(
            `grep -q "auth_param basic" /etc/squid/squid.conf 2>/dev/null || bash -c '${setupAuth}'`,
          );
          run(
            `grep -q "^http_port ${port}$" /etc/squid/squid.conf 2>/dev/null || echo "http_port ${port}" | tee -a /etc/squid/squid.conf`,
          );

          if (osInfo.isServiceRunning("squid")) {
            if (osInfo.isDebian || osInfo.isRhel) runQuiet("systemctl reload squid");
            else runQuiet("squid -k reconfigure");
          } else {
            osInfo.service("restart", "squid");
          }
        } else if (protocol === "socks5") {
          osInfo.install(osInfo.isDebian ? "dante-server ufw" : "dante-server firewalld");

          if (osInfo.isAlpine) run(`adduser -H -D ${shellEscape(user)} 2>/dev/null || true`);
          else run(`useradd -M -s /usr/sbin/nologin ${shellEscape(user)} 2>/dev/null || true`);
          run(`echo ${shellEscape(user)}:${shellEscape(pass)} | chpasswd`);

          const svcName = osInfo.isDebian ? "danted" : "sockd";
          writeDanteConfig(osInfo, [
            ...db.proxies.filter((p) => p.type === "socks5" && p.port != port),
            { port },
          ]);
          osInfo.service("restart", svcName);
        } else if (protocol === "mtproto") {
          let mtgSecret = pass;
          if (!fs.existsSync("/usr/local/bin/mtg")) {
            const arch = os.arch() === "arm64" ? "arm64" : "amd64";
            run(
              `wget -qO- https://github.com/9seconds/mtg/releases/download/v2.2.8/mtg-2.2.8-linux-${arch}.tar.gz | tar -xz -C /tmp`,
            );
            run(`mv /tmp/mtg-*/mtg /usr/local/bin/mtg && chmod +x /usr/local/bin/mtg`);
          }
          if (mtgSecret.length < 32) {
            mtgSecret = execSync("/usr/local/bin/mtg generate-secret tls").toString().trim();
            pass = mtgSecret;
          }
          osInfo.daemonize(
            `openfoxy-mtproto-${port}`,
            `/usr/local/bin/mtg run -b 0.0.0.0:${port} ${mtgSecret}`,
          );
        } else if (protocol === "residential") {
          const execPath = process.argv[0],
            scriptPath = fs.realpathSync(process.argv[1]);
          osInfo.daemonize(
            `openfoxy-residential-master`,
            `${execPath} ${scriptPath} serve-master ${flags.gateway}`,
          );
          configureFirewall(flags.gateway, osInfo);
        }

        configureFirewall(port, osInfo);
        db.proxies = db.proxies.filter((p) => p.port != port);
        const providerToken =
          protocol === "residential" ? crypto.randomBytes(18).toString("base64url") : undefined;
        db.proxies.push({
          type: protocol,
          user,
          pass,
          port,
          country: flags.country,
          limit: flags.limit,
          gatewayPort: protocol === "residential" ? flags.gateway : undefined,
          providerToken,
        });
        saveDb();

        var ip = await getPublicIp();
        console.log("\n\u2705 Proxy is live.\n");
        if (protocol === "mtproto") {
          console.log(
            "   \ud83c\udf10 TG Link: \x1b[32mtg://proxy?server=" +
              ip +
              "&port=" +
              port +
              "&secret=" +
              pass +
              "\x1b[0m\n",
          );
        } else if (protocol === "residential") {
          console.log(
            "   \ud83c\udf10 Proxy:    \x1b[32m" +
              user +
              ":" +
              pass +
              "@" +
              ip +
              ":" +
              port +
              "\x1b[0m",
          );
          console.log(
            "   \ud83c\udfe0 Provider: \x1b[36mnpx openfoxy provider " +
              ip +
              ":" +
              flags.gateway +
              ":" +
              providerToken +
              "\x1b[0m",
          );
          if (flags.country) console.log("   \ud83c\udf0d Country:  " + flags.country);
          if (flags.limit) console.log("   \ud83d\udcca Limit:    " + formatBytes(flags.limit));
          console.log();
        } else {
          console.log(
            "   \ud83c\udf10 Ready to use: \x1b[32m" +
              user +
              ":" +
              pass +
              "@" +
              ip +
              ":" +
              port +
              "\x1b[0m\n",
          );
        }
        break;
      }

      case "change": {
        var hasLimitFlag = rawArgs.some(function (a) {
          return a.startsWith("--limit=");
        });
        var hasCountryFlag = rawArgs.some(function (a) {
          return a.startsWith("--country=");
        });
        var chUser = args[0];
        var chPass = args[1];

        if (!chUser)
          return console.log(
            "\n\u274c Usage: openfoxy change <user> [newpass] [--limit=XGB] [--country=XX]\n",
          );
        if (!chPass && !hasLimitFlag && !hasCountryFlag)
          return console.log("\n\u274c Provide a new password or a flag (--limit=, --country=).\n");

        validateUser(chUser);

        var chUpdated = false;
        var chUpdatedTypes = new Set();
        var chChanges = [];

        db.proxies.forEach(function (p) {
          if (p.user !== chUser) return;

          if (chPass && (p.type === "http" || p.type === "socks5" || p.type === "residential")) {
            p.pass = chPass;
            chUpdated = true;
            chUpdatedTypes.add(p.type);
            if (p.type === "http")
              runQuiet(
                "htpasswd -b /etc/squid/passwords " +
                  shellEscape(chUser) +
                  " " +
                  shellEscape(chPass),
              );
            if (p.type === "socks5")
              runQuiet("echo " + shellEscape(chUser) + ":" + shellEscape(chPass) + " | chpasswd");
            chChanges.push("password");
          }

          if (hasLimitFlag && p.type === "residential") {
            var rawLimit = rawArgs
              .find(function (a) {
                return a.startsWith("--limit=");
              })
              .split("=")[1];
            p.limit =
              rawLimit === "0" || rawLimit.toLowerCase() === "none" ? null : parseBytes(rawLimit);
            validateLimitFlag(p.limit, rawLimit);
            chUpdated = true;
            chUpdatedTypes.add("residential");
            chChanges.push(p.limit ? "limit \u2192 " + formatBytes(p.limit) : "limit removed");
          }

          if (hasCountryFlag && p.type === "residential") {
            var rawCountry = rawArgs
              .find(function (a) {
                return a.startsWith("--country=");
              })
              .split("=")[1];
            p.country = rawCountry === "" ? null : rawCountry.toUpperCase();
            chUpdated = true;
            chUpdatedTypes.add("residential");
            chChanges.push(p.country ? "country \u2192 " + p.country : "country \u2192 any");
          }
        });

        if (chUpdated) {
          saveDb();
          if (chUpdatedTypes.has("http") && osInfo) {
            if (osInfo.isServiceRunning("squid"))
              runQuiet(osInfo.isAlpine ? "squid -k reconfigure" : "systemctl reload squid");
            else osInfo.service("restart", "squid");
          }
          if (chUpdatedTypes.has("socks5") && osInfo)
            osInfo.service("restart", osInfo.isDebian ? "danted" : "sockd");
          console.log("\n\u2705 Updated '" + chUser + "': " + chChanges.join(", ") + ".\n");
        } else {
          console.log("\n\u274c User '" + chUser + "' not found.\n");
        }
        break;
      }

      case "list": {
        console.log("\n\ud83e\udd8a OpenFoxy \u2014 Active Proxies");
        console.log(rule());
        const ip = await getPublicIp();

        if (db.proxies.length > 0) {
          db.proxies.forEach((p) => {
            const health = getProxyHealth(p);
            const icon =
              health === "exhausted"
                ? "\ud83d\udd34"
                : health === "warning"
                  ? "\ud83d\udfe1"
                  : "\ud83d\udfe2";
            const typeLabel = p.type.toUpperCase().padEnd(14);

            if (p.type === "residential") {
              const country = p.country ? "[" + p.country + "]" : "[ANY]";
              let line =
                icon +
                " " +
                typeLabel +
                country +
                " \u2192 " +
                p.user +
                ":" +
                p.pass +
                "@" +
                ip +
                ":" +
                p.port;
              if (p.limit) {
                const traffic = trackTraffic(p.port);
                const usage = traffic.rx + traffic.tx;
                const pct = Math.round((usage / p.limit) * 100);
                if (health === "exhausted") {
                  line += "  \u2716 LIMIT REACHED (" + formatBytes(p.limit) + ")";
                } else {
                  line += "  (" + pct + "% of " + formatBytes(p.limit) + ")";
                }
              }
              console.log(line);
            } else if (p.type === "mtproto") {
              console.log(
                icon +
                  " " +
                  typeLabel +
                  " \u2192 tg://proxy?server=" +
                  ip +
                  "&port=" +
                  p.port +
                  "&secret=" +
                  p.pass,
              );
            } else {
              console.log(
                icon +
                  " " +
                  typeLabel +
                  " \u2192 " +
                  p.user +
                  ":" +
                  p.pass +
                  "@" +
                  ip +
                  ":" +
                  p.port,
              );
            }
          });
        } else {
          console.log("   No proxies configured.");
        }
        console.log(rule() + "\n");
        break;
      }

      case "status": {
        console.log("\n\ud83d\udcca OpenFoxy \u2014 Status & Analytics");
        console.log(rule());

        function portOrService(port, serviceName) {
          if (osInfo && osInfo.isServiceRunning(serviceName)) return true;
          return runQuiet("nc -z 127.0.0.1 " + port + " 2>/dev/null");
        }

        var squidRunning = portOrService(
          db.proxies.find(function (p) {
            return p.type === "http";
          })?.port || 0,
          "squid",
        );
        var squidStatus = squidRunning ? "\ud83d\udfe2 RUNNING" : "\ud83d\udd34 STOPPED";
        var danteRunning = portOrService(
          db.proxies.find(function (p) {
            return p.type === "socks5";
          })?.port || 0,
          osInfo?.isDebian ? "danted" : "sockd",
        );
        var danteStatus = danteRunning ? "\ud83d\udfe2 RUNNING" : "\ud83d\udd34 STOPPED";
        var gatewayPort =
          db.proxies.find(function (p) {
            return p.type === "residential";
          })?.gatewayPort || 9000;
        var masterRunning = portOrService(gatewayPort, "openfoxy-residential-master");
        var masterStatus = masterRunning ? "\ud83d\udfe2 RUNNING" : "\ud83d\udd34 STOPPED";

        var mtprotoProxies = db.proxies.filter(function (p) {
          return p.type === "mtproto";
        });

        console.log("\ud83d\udee0\ufe0f  Core Services:");
        console.log("   \u251c\u2500 HTTP (Squid):    " + squidStatus);
        console.log("   \u251c\u2500 SOCKS5 (Dante):  " + danteStatus);
        console.log("   \u2514\u2500 Master Gateway:  " + masterStatus);
        if (mtprotoProxies.length > 0) {
          mtprotoProxies.forEach(function (p) {
            var mtgRunning = portOrService(p.port, "openfoxy-mtproto-" + p.port);
            var mtgStatus = mtgRunning ? "\ud83d\udfe2 RUNNING" : "\ud83d\udd34 STOPPED";
            console.log("      \u2514\u2500 MTProto :" + p.port + "  " + mtgStatus);
          });
        }
        console.log();

        console.log("\ud83d\udcc8 Traffic by Port:");
        if (db.proxies.length > 0) {
          db.proxies.forEach(function (p, idx) {
            var t = trackTraffic(p.port);
            var isLast = idx === db.proxies.length - 1;
            var prefix = isLast ? "\u2514\u2500" : "\u251c\u2500";
            console.log("   " + prefix + " Port " + p.port + " [" + p.type.toUpperCase() + "]");

            var mid = isLast ? " " : "\u2502";
            if (p.limit) {
              var usage = t.rx + t.tx;
              var pct = Math.min(Math.round((usage / p.limit) * 100), 100);
              var bar = progressBar(usage, p.limit);
              var statusText = pct >= 100 ? "\u2716 LIMIT REACHED" : pct + "%";
              console.log(
                "   " +
                  mid +
                  "  \u251c\u2500 Limit: [" +
                  bar +
                  "] " +
                  formatBytes(usage) +
                  " / " +
                  formatBytes(p.limit) +
                  " (" +
                  statusText +
                  ")",
              );
              console.log(
                "   " +
                  mid +
                  "  \u2514\u2500 Data:  " +
                  formatBytes(t.rx) +
                  " IN / " +
                  formatBytes(t.tx) +
                  " OUT",
              );
            } else {
              console.log(
                "   " +
                  mid +
                  "  \u2514\u2500 Data: " +
                  formatBytes(t.rx) +
                  " IN / " +
                  formatBytes(t.tx) +
                  " OUT",
              );
            }
          });
        } else {
          console.log("   \u2514\u2500 No proxies configured.\n");
        }

        var resState = [];
        try {
          resState = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
        } catch (e) {}

        if (resState.length > 0) {
          console.log("\n\ud83c\udfe0 Residential Provider Pool:");
          var byCountry = {};
          var totalRx = 0,
            totalTx = 0;
          resState.forEach(function (node) {
            if (!byCountry[node.country]) byCountry[node.country] = { nodes: [], rx: 0, tx: 0 };
            byCountry[node.country].nodes.push(node);
            byCountry[node.country].rx += node.rx;
            byCountry[node.country].tx += node.tx;
            totalRx += node.rx;
            totalTx += node.tx;
          });

          Object.entries(byCountry).forEach(function (entry) {
            var country = entry[0],
              stats = entry[1];
            console.log(
              "   \ud83c\udf0d " +
                country +
                ": " +
                stats.nodes.length +
                " Node" +
                (stats.nodes.length > 1 ? "s" : "") +
                " Active",
            );
            stats.nodes.forEach(function (n) {
              console.log(
                "      \u251c\u2500 " +
                  n.ip +
                  " \u2014 " +
                  formatBytes(n.rx) +
                  " IN / " +
                  formatBytes(n.tx) +
                  " OUT",
              );
            });
            console.log(
              "      \u2514\u2500 Subtotal: " +
                formatBytes(stats.rx) +
                " IN / " +
                formatBytes(stats.tx) +
                " OUT",
            );
          });
          console.log(
            "\n   \ud83d\udcca Total: " +
              resState.length +
              " Node" +
              (resState.length > 1 ? "s" : "") +
              " \u2014 " +
              formatBytes(totalRx) +
              " IN / " +
              formatBytes(totalTx) +
              " OUT",
          );
        }
        console.log(rule() + "\n");
        break;
      }

      case "stop":
      case "start": {
        const target = args[0];
        let toManage = [];

        if (!target) toManage = db.proxies;
        else if (["http", "socks5", "mtproto", "residential"].includes(target))
          toManage = db.proxies.filter((p) => p.type === target);
        else toManage = db.proxies.filter((p) => p.port == target);

        const types = [...new Set(toManage.map((p) => p.type))];
        if (types.includes("http")) osInfo.service(command, "squid");
        if (types.includes("socks5")) osInfo.service(command, osInfo.isDebian ? "danted" : "sockd");
        if (types.includes("residential")) osInfo.service(command, `openfoxy-residential-master`);
        toManage.forEach((p) => {
          if (p.type === "mtproto") osInfo.service(command, `openfoxy-mtproto-${p.port}`);
        });

        console.log(
          "\n\u2705 " + (command === "start" ? "Started" : "Stopped") + " requested services.\n",
        );
        break;
      }

      case "delete": {
        const [user, port] = args;
        if (!user || !port) return console.log("\n\u274c Usage: openfoxy delete <user> <port>\n");

        validateUser(user);
        const deletePort = validatePort(port);

        const proxy = db.proxies.find((p) => p.port == deletePort && p.user === user);
        if (!proxy) return console.log("\n\u274c Proxy not found in database.\n");

        if (osInfo) configureFirewall(deletePort, osInfo, true);

        const remaining = db.proxies.filter((p) => p !== proxy);

        if (proxy.type === "http") {
          if (!remaining.some((p) => p.type === "http" && p.user === user)) {
            runQuiet(`htpasswd -D /etc/squid/passwords ${shellEscape(user)}`);
          }
          runQuiet(`sed -i '/^http_port ${deletePort}$/d' /etc/squid/squid.conf`);
          if (osInfo.isServiceRunning("squid"))
            runQuiet(osInfo.isAlpine ? "squid -k reconfigure" : "systemctl reload squid");
          else osInfo.service("restart", "squid");
        } else if (proxy.type === "socks5") {
          if (!remaining.some((p) => p.type === "socks5" && p.user === user)) {
            runQuiet(
              osInfo.isAlpine ? `deluser ${shellEscape(user)}` : `userdel ${shellEscape(user)}`,
            );
          }
          writeDanteConfig(
            osInfo,
            remaining.filter((p) => p.type === "socks5"),
          );
          osInfo.service("restart", osInfo.isDebian ? "danted" : "sockd");
        } else if (proxy.type === "mtproto" || proxy.type === "residential") {
          const svcName =
            proxy.type === "mtproto"
              ? `openfoxy-mtproto-${deletePort}`
              : `openfoxy-residential-master`;
          if (proxy.type === "residential" && remaining.some((p) => p.type === "residential")) {
            db.proxies = remaining;
            saveDb();
            console.log("\n\u2705 Deleted " + proxy.type + " proxy on port " + deletePort + ".\n");
            break;
          }
          osInfo.service("stop", svcName);
          if (osInfo.isAlpine)
            runQuiet(`rc-update del ${svcName} default && rm -f /etc/init.d/${svcName}`);
          else
            runQuiet(
              `systemctl disable ${svcName} && rm -f /etc/systemd/system/${svcName}.service && systemctl daemon-reload`,
            );
        }

        db.proxies = remaining;
        saveDb();
        console.log("\n\u2705 Deleted " + proxy.type + " proxy on port " + deletePort + ".\n");
        break;
      }

      case "uninstall": {
        console.log("\n\u26a0\ufe0f  Removing OpenFoxy...\n");

        // Stop base services
        osInfo.service("stop", "squid");
        osInfo.service("stop", osInfo.isDebian ? "danted" : "sockd");
        osInfo.service("stop", "openfoxy-residential-master");

        // Cleanup DB, State & Firewall rules
        db.proxies.forEach((p) => configureFirewall(p.port, osInfo, true));
        const gwPort = db.proxies.find((p) => p.type === "residential")?.gatewayPort || 9000;
        configureFirewall(gwPort, osInfo, true);
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);

        // Remove binaries and configs
        runQuiet(`rm -rf /etc/squid /etc/danted.conf /etc/sockd.conf /usr/local/bin/mtg`);

        // Remove individual service files
        if (osInfo.isAlpine) {
          runQuiet(
            `find /etc/init.d/ -name 'openfoxy-*' -exec rc-update del {} default \\; -exec rm -f {} \\;`,
          );
        } else {
          runQuiet(`systemctl disable squid danted openfoxy-residential-master 2>/dev/null`);
          runQuiet(
            `find /etc/systemd/system/ -name 'openfoxy-*.service' -delete && systemctl daemon-reload`,
          );
        }

        console.log("\u2705 Uninstallation complete. System is clean.\n");
        break;
      }

      default:
        if (command && command !== "docker") console.log("\n\u274c Unknown command: " + command);
        if (command !== "docker") printHelp();

        // Handle docker gracefully at bottom
        if (command === "docker") {
          const [dUser, dPass, dPort, dProto] = args;
          if (!dUser || !dPass || !dPort) {
            console.log(
              "\n\u274c Usage: docker run ... openfoxy <user> <pass> <port> [protocol]\n",
            );
            process.exit(1);
          }
          validateUser(dUser);
          const dockerPort = validatePort(dPort);
          const protocol = (dProto || "http").toLowerCase();
          validateProtocol(protocol);
          flags.gateway = validatePort(flags.gateway);
          validateLimitFlag(
            flags.limit,
            rawArgs.find(function (a) {
              return a.startsWith("--limit=");
            }),
          );
          console.log(
            "\n\ud83d\udc33 Initializing Docker [" +
              protocol.toUpperCase() +
              "] \u2192 Port " +
              dockerPort +
              "...\n",
          );

          if (protocol === "http") {
            run("mkdir -p /etc/squid && touch /etc/squid/passwords");
            run(`htpasswd -b -c /etc/squid/passwords ${shellEscape(dUser)} ${shellEscape(dPass)}`);
            run(
              `sh -c 'AUTH_PATH=$(find /usr/lib/squid /usr/lib64/squid /usr/libexec/squid -name basic_ncsa_auth 2>/dev/null | head -n 1)\ncat <<EOF > /etc/squid/squid.conf\nhttp_port ${dockerPort}\nauth_param basic program $AUTH_PATH /etc/squid/passwords\nacl authenticated proxy_auth REQUIRED\nhttp_access allow authenticated\nhttp_access deny all\nEOF'`,
            );
            execSync("squid -N -d 1", { stdio: "inherit" });
          } else if (protocol === "socks5") {
            run(
              `adduser -H -D ${shellEscape(dUser)} 2>/dev/null || true; echo ${shellEscape(dUser)}:${shellEscape(dPass)} | chpasswd`,
            );
            fs.writeFileSync(
              "/etc/sockd.conf",
              `logoutput: stderr\ninternal: 0.0.0.0 port = ${dockerPort}\nexternal: eth0\nsocksmethod: username\nclientmethod: none\nuser.privileged: root\nuser.unprivileged: nobody\nclient pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }\nsocks pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }\n`,
            );
            execSync("sockd -f /etc/sockd.conf", { stdio: "inherit" });
          } else if (protocol === "mtproto") {
            // Dynamically grab the correct arch for Docker container
            const arch = require("os").arch() === "arm64" ? "arm64" : "amd64";
            run(
              `wget -qO- https://github.com/9seconds/mtg/releases/download/v2.2.8/mtg-2.2.8-linux-${arch}.tar.gz | tar -xz -C /tmp && mv /tmp/mtg-*/mtg /usr/local/bin/mtg && chmod +x /usr/local/bin/mtg`,
            );
            require("child_process").execSync(
              `/usr/local/bin/mtg run -b 0.0.0.0:${dockerPort} ${dPass}`,
              { stdio: "inherit" },
            );
          } else if (protocol === "residential") {
            const providerToken = crypto.randomBytes(18).toString("base64url");
            db.proxies = db.proxies.filter((p) => p.port != dockerPort);
            db.proxies.push({
              type: "residential",
              user: dUser,
              pass: dPass,
              port: dockerPort,
              country: flags.country,
              limit: flags.limit,
              gatewayPort: flags.gateway,
              providerToken,
            });
            saveDb();
            serveResidentialMaster(flags.gateway);
          }
        }
    }
  } catch (error) {
    console.error(
      "\n\u274c Error processing command: " +
        (error && error.message ? error.message : "Check privileges and network.") +
        "\n",
    );
  }
})();
