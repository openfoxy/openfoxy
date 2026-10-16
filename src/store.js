import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * On-disk layout. The CLI is the only writer of the config directory; the residential
 * master daemon is the only writer of the state directory. Both can be relocated with
 * environment variables (used by tests and unusual installs).
 */
export const CONFIG_DIR = process.env.OPENFOXY_CONFIG_DIR ?? "/etc/openfoxy";
export const STATE_DIR = process.env.OPENFOXY_STATE_DIR ?? "/var/lib/openfoxy";

export const paths = Object.freeze({
  config: path.join(CONFIG_DIR, "config.json"),
  access: path.join(CONFIG_DIR, "access.json"),
  traffic: path.join(STATE_DIR, "traffic.json"),
  providers: path.join(STATE_DIR, "providers.json"),
});

export const DEFAULT_GATEWAY_PORT = 9000;

export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Corrupted file ${file}: ${error.message}`, { cause: error });
  }
}

/** Atomic, owner-only write: readers never observe a partially written file. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @typedef {object} Proxy
 * @property {string} id         Stable identifier (traffic for residential proxies is keyed by it).
 * @property {"http"|"socks5"|"mtproto"|"residential"} type
 * @property {string} user
 * @property {string} pass       Password, or the FakeTLS secret for MTProto.
 * @property {number} port
 * @property {boolean} enabled
 * @property {string|null} country  Residential only: required provider country.
 * @property {number|null} limit    Residential only: traffic cap in bytes.
 * @property {string} createdAt
 *
 * @typedef {object} Config
 * @property {Proxy[]} proxies
 * @property {{ gatewayPort: number, providerToken: string } | null} residential
 */

/** @returns {Config} */
export function loadConfig() {
  const config = readJson(paths.config, {});
  return {
    proxies: Array.isArray(config.proxies) ? config.proxies : [],
    residential: config.residential ?? null,
  };
}

export function saveConfig(config) {
  writeJson(paths.config, { proxies: config.proxies, residential: config.residential });
}

export function newProxyId() {
  return randomBytes(6).toString("hex");
}

export function newProviderToken() {
  return randomBytes(24).toString("base64url");
}

/** Provider access control: `blocked` maps IP → { reason, at }; a non-empty `allowed` list is exclusive. */
export function loadAccess() {
  const access = readJson(paths.access, {});
  return {
    blocked: access.blocked && typeof access.blocked === "object" ? access.blocked : {},
    allowed: Array.isArray(access.allowed) ? access.allowed : [],
  };
}

export function saveAccess(access) {
  writeJson(paths.access, access);
}

export function isProviderAllowed(access, ip) {
  if (Object.hasOwn(access.blocked, ip)) return false;
  return access.allowed.length === 0 || access.allowed.includes(ip);
}

/** @returns {Record<string, { rx: number, tx: number }>} Residential traffic keyed by proxy id. */
export function loadTraffic() {
  return readJson(paths.traffic, {});
}
