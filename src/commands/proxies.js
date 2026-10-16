import fs from "node:fs";
import { applyConfig, RESIDENTIAL_SERVICE } from "../apply.js";
import { removeDante } from "../backends/dante.js";
import {
  DEFAULT_FRONTING_DOMAIN,
  MTG_BIN,
  ensureMtg,
  generateSecret,
  serviceName as mtprotoService,
} from "../backends/mtproto.js";
import { removeSquid } from "../backends/squid.js";
import { color, formatBytes } from "../format.js";
import { getPublicIp } from "../net-info.js";
import * as store from "../store.js";
import { closePort, openPort } from "../system/firewall.js";
import { ensureBinaries, requirePlatform } from "../system/platform.js";
import {
  assertUserAvailable,
  managedUsers,
  removeProxyUser,
  setProxyUser,
} from "../system/users.js";
import {
  PROTOCOLS,
  UsageError,
  isMtprotoSecret,
  parseCountry,
  parseLimit,
  requireDomain,
  requirePassword,
  requirePort,
  requireProtocol,
  requireUser,
} from "../validation.js";
import { connectionString, providerCommand, requireFreePort, requireRoot } from "./common.js";

/** Validated `add` arguments; shared with the Docker entry point. */
export function parseAddArgs([user, pass, port, protocol], options) {
  if (!user || !pass || !port) {
    throw new UsageError("Usage: openfoxy add <user> <pass> <port> [protocol] [options]", {
      exitCode: 2,
    });
  }
  const proxy = {
    id: store.newProxyId(),
    type: requireProtocol(protocol ?? "http"),
    user: requireUser(user),
    pass,
    port: requirePort(port),
    enabled: true,
    country: null,
    limit: null,
    createdAt: new Date().toISOString(),
  };
  const residentialOnly = ["country", "limit", "gateway"].filter(
    (key) => options[key] !== undefined,
  );
  if (proxy.type !== "residential" && residentialOnly.length) {
    throw new UsageError(`--${residentialOnly.join(", --")} only applies to residential proxies.`);
  }
  if (proxy.type !== "mtproto" && options.domain !== undefined) {
    throw new UsageError("--domain only applies to mtproto proxies.");
  }

  if (proxy.type === "mtproto") {
    // Any non-secret value (e.g. "auto") asks OpenFoxy to generate a FakeTLS secret.
    proxy.pass = isMtprotoSecret(pass)
      ? pass
      : generateSecret(options.domain ? requireDomain(options.domain) : DEFAULT_FRONTING_DOMAIN);
  } else {
    proxy.pass = requirePassword(pass);
  }
  if (proxy.type === "residential") {
    proxy.country = parseCountry(options.country);
    proxy.limit = options.limit === undefined ? null : parseLimit(options.limit);
  }
  const gatewayPort =
    options.gateway === undefined ? null : requirePort(options.gateway, "gateway port");
  return { proxy, gatewayPort };
}

/** Saves `next`, applies it, and restores `previous` if applying fails. */
function commit(platform, previous, next, types) {
  store.saveConfig(next);
  try {
    applyConfig(platform, next, types);
  } catch (error) {
    store.saveConfig(previous);
    try {
      applyConfig(platform, previous, types);
    } catch {
      // Report the original failure below.
    }
    throw error;
  }
}

function installDependencies(platform, type) {
  const binaries = { iptables: "iptables" };
  if (type === "http") Object.assign(binaries, { squid: "squid", htpasswd: "htpasswd" });
  if (type === "socks5")
    Object.assign(binaries, { [platform.danteService]: "dante", ip: "iproute" });
  ensureBinaries(platform, binaries);
}

export async function add(args, options) {
  const { proxy, gatewayPort } = parseAddArgs(args, options);
  requireRoot();
  const platform = requirePlatform();
  const config = store.loadConfig();
  const previous = structuredClone(config);

  const clash = config.proxies.find((p) => p.port === proxy.port);
  if (clash) {
    throw new UsageError(
      `Port ${proxy.port} already serves a ${clash.type} proxy for '${clash.user}'. Delete it first.`,
    );
  }
  if (config.residential?.gatewayPort === proxy.port) {
    throw new UsageError(`Port ${proxy.port} is the residential gateway port.`);
  }
  if (proxy.type === "http" || proxy.type === "socks5") {
    // Squid's password file and Dante's system accounts hold one password per user.
    const sameUser = config.proxies.find((p) => p.type === proxy.type && p.user === proxy.user);
    if (sameUser && sameUser.pass !== proxy.pass) {
      throw new UsageError(
        `User '${proxy.user}' already has a ${proxy.type} proxy with another password. ` +
          `Use the same password or run 'openfoxy change ${proxy.user} <newpass>'.`,
      );
    }
  }
  if (proxy.type === "socks5") assertUserAvailable(proxy.user);
  await requireFreePort(proxy.port);

  let oldGateway = null;
  if (proxy.type === "residential") {
    const wantedGateway =
      gatewayPort ?? config.residential?.gatewayPort ?? store.DEFAULT_GATEWAY_PORT;
    if (config.proxies.some((p) => p.port === wantedGateway) || wantedGateway === proxy.port) {
      throw new UsageError(`Gateway port ${wantedGateway} is already used by a proxy.`);
    }
    if (!config.residential) {
      await requireFreePort(wantedGateway);
      config.residential = { gatewayPort: wantedGateway, providerToken: store.newProviderToken() };
    } else if (config.residential.gatewayPort !== wantedGateway) {
      await requireFreePort(wantedGateway);
      oldGateway = config.residential.gatewayPort;
      config.residential = { ...config.residential, gatewayPort: wantedGateway };
    }
  }

  console.log(`\n🚀 Deploying ${proxy.type.toUpperCase()} proxy on port ${proxy.port}...\n`);
  installDependencies(platform, proxy.type);
  if (proxy.type === "mtproto") await ensureMtg();
  if (proxy.type === "socks5") setProxyUser(proxy.user, proxy.pass);

  config.proxies.push(proxy);
  commit(platform, previous, config, [proxy.type]);
  openPort(proxy.port);
  if (proxy.type === "residential") {
    openPort(config.residential.gatewayPort);
    if (oldGateway !== null) closePort(oldGateway);
  }

  const ip = await getPublicIp();
  console.log("✅ Proxy is live.\n");
  if (proxy.type === "mtproto") {
    console.log(`   🌐 Telegram: ${color.green(connectionString(proxy, ip))}\n`);
  } else if (proxy.type === "residential") {
    console.log(`   🌐 Proxy:    ${color.green(connectionString(proxy, ip))}  (HTTP and SOCKS5)`);
    console.log(`   🏠 Provider: ${color.cyan(providerCommand(ip, config.residential))}`);
    if (proxy.country) console.log(`   🌍 Country:  ${proxy.country}`);
    if (proxy.limit) console.log(`   📊 Limit:    ${formatBytes(proxy.limit)}`);
    if (oldGateway !== null) {
      console.log(
        `   ⚠️  Gateway moved from ${oldGateway}; providers must reconnect to the new port.`,
      );
    }
    console.log();
  } else {
    console.log(`   🌐 Ready to use: ${color.green(connectionString(proxy, ip))}\n`);
  }
}

export function change([user, newPass], options) {
  if (!user) {
    throw new UsageError(
      "Usage: openfoxy change <user> [newpass] [--limit=SIZE|0] [--country=XX]",
      {
        exitCode: 2,
      },
    );
  }
  requireUser(user);
  const pass = newPass === undefined ? undefined : requirePassword(newPass);
  const limit =
    options.limit === undefined ? undefined : parseLimit(options.limit, { allowClear: true });
  const country = options.country === undefined ? undefined : parseCountry(options.country);
  if (pass === undefined && limit === undefined && country === undefined) {
    throw new UsageError("Nothing to change: give a new password, --limit, or --country.");
  }
  requireRoot();
  const platform = requirePlatform();
  const config = store.loadConfig();
  const previous = structuredClone(config);

  const owned = config.proxies.filter((p) => p.user === user);
  if (!owned.length) throw new UsageError(`No proxies belong to user '${user}'.`);
  const residential = owned.filter((p) => p.type === "residential");
  if ((limit !== undefined || country !== undefined) && !residential.length) {
    throw new UsageError("--limit and --country only apply to residential proxies.");
  }

  const changes = [];
  const types = new Set();
  if (pass !== undefined) {
    const withPasswords = owned.filter((p) => p.type !== "mtproto");
    if (!withPasswords.length)
      throw new UsageError("MTProto proxies use secrets; recreate them instead.");
    for (const proxy of withPasswords) {
      proxy.pass = pass;
      types.add(proxy.type);
    }
    if (types.has("socks5")) setProxyUser(user, pass);
    changes.push("password");
  }
  for (const proxy of residential) {
    if (limit !== undefined) proxy.limit = limit;
    if (country !== undefined) proxy.country = country;
  }
  if (limit !== undefined) changes.push(limit ? `limit → ${formatBytes(limit)}` : "limit removed");
  if (country !== undefined) changes.push(`country → ${country ?? "any"}`);

  // The residential master re-reads the config on its own; no service change is needed.
  types.delete("residential");
  commit(platform, previous, config, types);
  console.log(`\n✅ Updated '${user}': ${changes.join(", ")}.\n`);
}

export function remove([user, port]) {
  if (!user || !port) throw new UsageError("Usage: openfoxy delete <user> <port>", { exitCode: 2 });
  requireUser(user);
  const deletePort = requirePort(port);
  requireRoot();
  const platform = requirePlatform();
  const config = store.loadConfig();
  const previous = structuredClone(config);

  const proxy = config.proxies.find((p) => p.port === deletePort && p.user === user);
  if (!proxy) throw new UsageError(`No proxy for '${user}' on port ${deletePort}.`);
  config.proxies = config.proxies.filter((p) => p !== proxy);

  if (proxy.type === "mtproto") platform.services.removeDaemon(mtprotoService(proxy.port));
  let closedGateway = null;
  if (proxy.type === "residential" && !config.proxies.some((p) => p.type === "residential")) {
    closedGateway = config.residential?.gatewayPort ?? null;
    config.residential = null;
  }
  commit(platform, previous, config, [proxy.type]);

  if (
    proxy.type === "socks5" &&
    !config.proxies.some((p) => p.type === "socks5" && p.user === user)
  ) {
    removeProxyUser(user);
  }
  closePort(deletePort);
  if (closedGateway !== null) closePort(closedGateway);
  console.log(`\n✅ Deleted ${proxy.type} proxy on port ${deletePort}.\n`);
}

export function setEnabled([target], enabled) {
  let match = () => true;
  if (target !== undefined) {
    if (PROTOCOLS.includes(target.toLowerCase())) {
      match = (p) => p.type === target.toLowerCase();
    } else {
      const port = requirePort(target);
      match = (p) => p.port === port;
    }
  }
  requireRoot();
  const platform = requirePlatform();
  const config = store.loadConfig();
  const previous = structuredClone(config);

  const selected = config.proxies.filter(match);
  if (!selected.length) throw new UsageError(`No proxies match '${target}'.`);
  for (const proxy of selected) proxy.enabled = enabled;
  commit(platform, previous, config, new Set(selected.map((p) => p.type)));

  const verb = enabled ? "Started" : "Stopped";
  console.log(`\n✅ ${verb} ${selected.length} ${selected.length === 1 ? "proxy" : "proxies"}.\n`);
}

export function uninstall() {
  requireRoot();
  const platform = requirePlatform();
  const config = store.loadConfig();
  console.log("\n⚠️  Removing OpenFoxy...\n");

  for (const proxy of config.proxies) {
    if (proxy.type === "mtproto") platform.services.removeDaemon(mtprotoService(proxy.port));
    closePort(proxy.port);
  }
  if (platform.services.hasDaemon(RESIDENTIAL_SERVICE)) {
    platform.services.removeDaemon(RESIDENTIAL_SERVICE);
  }
  if (config.residential) closePort(config.residential.gatewayPort);
  if (config.proxies.some((p) => p.type === "http")) removeSquid(platform);
  if (config.proxies.some((p) => p.type === "socks5")) removeDante(platform);
  for (const user of managedUsers()) removeProxyUser(user);
  fs.rmSync(MTG_BIN, { force: true });
  fs.rmSync(store.CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(store.STATE_DIR, { recursive: true, force: true });
  console.log("✅ OpenFoxy has been removed.\n");
}
