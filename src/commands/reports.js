import { RESIDENTIAL_SERVICE } from "../apply.js";
import { serviceName as mtprotoService } from "../backends/mtproto.js";
import {
  HEALTH_ICON,
  formatBytes,
  formatTimestamp,
  limitHealth,
  plural,
  progressBar,
  rule,
} from "../format.js";
import { getPublicIp } from "../net-info.js";
import * as store from "../store.js";
import { readPortCounters } from "../system/firewall.js";
import { detectPlatform } from "../system/platform.js";
import { UsageError, requireIp } from "../validation.js";
import { connectionString, requireRoot } from "./common.js";

/** Traffic per proxy: app-level counters for residential, iptables counters otherwise. */
function trafficFor(proxies) {
  const residential = store.loadTraffic();
  const ports = proxies.some((p) => p.type !== "residential") ? readPortCounters() : new Map();
  return new Map(
    proxies.map((proxy) => [
      proxy.id,
      (proxy.type === "residential" ? residential[proxy.id] : ports.get(proxy.port)) ?? {
        rx: 0,
        tx: 0,
      },
    ]),
  );
}

function health(proxy, counters) {
  if (proxy.enabled === false) return "stopped";
  return limitHealth(counters.rx + counters.tx, proxy.limit);
}

function loadProviderState() {
  const state = store.readJson(store.paths.providers, {});
  return {
    providers: Array.isArray(state.providers) ? state.providers : [],
    bans: Array.isArray(state.bans) ? state.bans : [],
  };
}

export async function list() {
  requireRoot();
  const { proxies } = store.loadConfig();
  console.log("\n🦊 OpenFoxy: proxies");
  console.log(rule());
  if (!proxies.length) {
    console.log("   No proxies configured.");
    console.log(`${rule()}\n`);
    return;
  }
  const ip = await getPublicIp();
  const traffic = trafficFor(proxies);
  for (const proxy of proxies) {
    const counters = traffic.get(proxy.id);
    const state = health(proxy, counters);
    const label = proxy.type.toUpperCase().padEnd(12);
    const country = proxy.type === "residential" ? `[${proxy.country ?? "ANY"}] ` : "";
    let line = `${HEALTH_ICON[state]} ${label}${country}→ ${connectionString(proxy, ip)}`;
    if (proxy.limit) {
      const used = counters.rx + counters.tx;
      line +=
        state === "exhausted"
          ? `  ✖ LIMIT REACHED (${formatBytes(proxy.limit)})`
          : `  (${Math.round((used / proxy.limit) * 100)}% of ${formatBytes(proxy.limit)})`;
    }
    if (state === "stopped") line += "  (stopped)";
    console.log(line);
  }
  console.log(`${rule()}\n`);
}

export function status() {
  requireRoot();
  const { proxies, residential } = store.loadConfig();
  const platform = detectPlatform();
  const isActive = (name) => platform?.services?.isActive(name) ?? false;
  const badge = (running) => (running ? "🟢 RUNNING" : "🔴 STOPPED");
  const has = (type) => proxies.some((p) => p.type === type);

  console.log("\n📊 OpenFoxy: status");
  console.log(rule());
  console.log("🛠️  Services:");
  const services = [];
  if (has("http")) services.push(["HTTP (Squid)", isActive("squid")]);
  if (has("socks5")) services.push(["SOCKS5 (Dante)", isActive(platform?.danteService ?? "sockd")]);
  if (has("residential")) {
    services.push([
      `Residential gateway :${residential?.gatewayPort}`,
      isActive(RESIDENTIAL_SERVICE),
    ]);
  }
  for (const proxy of proxies.filter((p) => p.type === "mtproto")) {
    services.push([`MTProto :${proxy.port}`, isActive(mtprotoService(proxy.port))]);
  }
  if (!services.length) console.log("   └─ No services configured.");
  services.forEach(([name, running], index) => {
    const branch = index === services.length - 1 ? "└─" : "├─";
    console.log(`   ${branch} ${name.padEnd(28)}${badge(running)}`);
  });

  console.log("\n📈 Traffic:");
  const traffic = trafficFor(proxies);
  if (!proxies.length) console.log("   └─ No proxies configured.");
  proxies.forEach((proxy, index) => {
    const last = index === proxies.length - 1;
    const stem = last ? " " : "│";
    const { rx, tx } = traffic.get(proxy.id);
    const stopped = proxy.enabled === false ? " (stopped)" : "";
    console.log(
      `   ${last ? "└─" : "├─"} Port ${proxy.port} [${proxy.type.toUpperCase()}]${stopped}`,
    );
    if (proxy.limit) {
      const used = rx + tx;
      const pct = Math.min(Math.round((used / proxy.limit) * 100), 100);
      const state = used >= proxy.limit ? "✖ LIMIT REACHED" : `${pct}%`;
      console.log(
        `   ${stem}  ├─ Limit: [${progressBar(used, proxy.limit)}] ${formatBytes(used)} / ${formatBytes(proxy.limit)} (${state})`,
      );
      console.log(`   ${stem}  └─ Data:  ${formatBytes(rx)} IN / ${formatBytes(tx)} OUT`);
    } else {
      console.log(`   ${stem}  └─ Data: ${formatBytes(rx)} IN / ${formatBytes(tx)} OUT`);
    }
  });

  const { providers } = loadProviderState();
  if (providers.length) {
    console.log("\n🏠 Residential provider pool:");
    const byCountry = Map.groupBy(providers, (node) => node.country);
    for (const [country, nodes] of byCountry) {
      console.log(`   🌍 ${country}: ${plural(nodes.length, "node")}`);
      for (const node of nodes) {
        console.log(
          `      ├─ ${node.ip}: ${formatBytes(node.rx)} IN / ${formatBytes(node.tx)} OUT, ${plural(node.streams, "stream")}`,
        );
      }
    }
    const totalRx = providers.reduce((sum, node) => sum + node.rx, 0);
    const totalTx = providers.reduce((sum, node) => sum + node.tx, 0);
    console.log(
      `\n   📊 Total: ${plural(providers.length, "node")}: ${formatBytes(totalRx)} IN / ${formatBytes(totalTx)} OUT`,
    );
  }
  console.log(`${rule()}\n`);
}

function showProviders() {
  const { providers, bans } = loadProviderState();
  const { blocked, allowed } = store.loadAccess();
  console.log("\n🏠 Residential providers");
  console.log(rule());
  if (providers.length) {
    console.log(`\n🟢 Connected (${providers.length}):`);
    for (const p of providers) {
      console.log(`   └─ ${p.ip} [${p.country}] since ${formatTimestamp(p.connectedAt)}`);
    }
  } else {
    console.log("\n🔴 No providers connected.");
  }
  if (bans.length) {
    console.log(`\n⏳ Temporarily banned (${bans.length}):`);
    for (const ban of bans) {
      console.log(`   └─ ${ban.ip}: ${ban.reason} (until ${formatTimestamp(ban.until)})`);
    }
  }
  const blockedEntries = Object.entries(blocked);
  if (blockedEntries.length) {
    console.log(`\n🚫 Blocked (${blockedEntries.length}):`);
    for (const [ip, entry] of blockedEntries) {
      console.log(`   └─ ${ip}: ${entry.reason} (${formatTimestamp(entry.at)})`);
    }
  }
  if (allowed.length) {
    console.log(`\n✅ Allowlist (${allowed.length}), only these providers may join:`);
    for (const ip of allowed) console.log(`   └─ ${ip}`);
  }
  console.log(`\n${rule()}\n`);
}

export function providers([action, ip, ...reason]) {
  requireRoot();
  if (action === undefined) return showProviders();

  const actions = {
    block: (access, address) => {
      access.blocked[address] = {
        reason: reason.join(" ") || "manual",
        at: new Date().toISOString(),
      };
      return `Blocked provider ${address}.`;
    },
    unblock: (access, address) => {
      if (!Object.hasOwn(access.blocked, address))
        throw new UsageError(`${address} is not blocked.`);
      delete access.blocked[address];
      return `Unblocked provider ${address}.`;
    },
    allow: (access, address) => {
      if (!access.allowed.includes(address)) access.allowed.push(address);
      return `Added ${address} to the allowlist.`;
    },
    disallow: (access, address) => {
      if (!access.allowed.includes(address)) throw new UsageError(`${address} is not allowlisted.`);
      access.allowed = access.allowed.filter((entry) => entry !== address);
      return `Removed ${address} from the allowlist.`;
    },
  };
  const apply = actions[action];
  if (!apply) {
    throw new UsageError(`Unknown action '${action}'. Use block, unblock, allow, or disallow.`, {
      exitCode: 2,
    });
  }
  if (!ip) throw new UsageError(`Usage: openfoxy providers ${action} <ip>`, { exitCode: 2 });
  const access = store.loadAccess();
  const message = apply(access, requireIp(ip));
  store.saveAccess(access);
  console.log(`\n✅ ${message}\n`);
}
