import { isIP } from "node:net";

/** Error with a user-facing message; the CLI prints it without a stack trace. */
export class UsageError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "UsageError";
    this.exitCode = exitCode;
  }
}

export const PROTOCOLS = Object.freeze(["http", "socks5", "mtproto", "residential"]);

const BYTE_UNITS = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Parses sizes such as `500MB`, `2GB`, `1.5G`, or `1024` into an integer byte count. */
export function parseBytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const bytes = Math.round(Number(match[1]) * BYTE_UNITS[match[2].toUpperCase()]);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/** Strictly parses a TCP port; rejects anything that is not a plain decimal in 1..65535. */
export function parsePort(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

export function requirePort(value, label = "port") {
  const port = parsePort(value);
  if (port === null)
    throw new UsageError(`Invalid ${label} '${value}'. Use a number between 1 and 65535.`);
  return port;
}

/**
 * Proxy usernames double as Linux account names for SOCKS5 (Dante authenticates against
 * /etc/passwd), so they must be valid, option-safe account names.
 */
export function requireUser(value) {
  const user = String(value ?? "");
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(user)) {
    throw new UsageError(
      "Invalid username. Use 1-32 letters, digits, '_' or '-', starting with a letter or '_'.",
    );
  }
  return user;
}

export function requirePassword(value) {
  const pass = String(value ?? "");
  // Control characters would corrupt chpasswd/htpasswd input and the generated config files.
  const hasControlCharacter = [...pass].some(
    (char) => char.charCodeAt(0) < 0x20 || char === "\x7f",
  );
  if (pass.length < 1 || pass.length > 128 || hasControlCharacter) {
    throw new UsageError("Invalid password. Use 1-128 printable characters.");
  }
  return pass;
}

export function requireProtocol(value) {
  const protocol = String(value ?? "http").toLowerCase();
  if (!PROTOCOLS.includes(protocol)) {
    throw new UsageError(`Invalid protocol '${value}'. Use ${PROTOCOLS.join(", ")}.`);
  }
  return protocol;
}

/** ISO 3166-1 alpha-2 country code, upper-cased. An empty value means "any country". */
export function parseCountry(value) {
  const country = String(value ?? "")
    .trim()
    .toUpperCase();
  if (country === "") return null;
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new UsageError(`Invalid country '${value}'. Use a two-letter code such as US or DE.`);
  }
  return country;
}

/** Parses `--limit`; `0` and `none` clear the limit when `allowClear` is set. */
export function parseLimit(value, { allowClear = false } = {}) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (allowClear && (raw === "0" || raw === "none")) return null;
  const bytes = parseBytes(raw);
  if (bytes === null) {
    throw new UsageError(
      `Invalid limit '${value}'. Use a size such as 500MB or 2GB${allowClear ? ", or 0/none to remove it" : ""}.`,
    );
  }
  return bytes;
}

export function requireIp(value) {
  const ip = normalizeIp(value);
  if (!isIP(ip)) throw new UsageError(`Invalid IP address '${value}'.`);
  return ip;
}

/** Strips the IPv4-mapped IPv6 prefix so `::ffff:203.0.113.5` and `203.0.113.5` compare equal. */
export function normalizeIp(value) {
  const ip = String(value ?? "").trim();
  return /^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(ip) ? ip.slice(7) : ip.toLowerCase();
}

/** Hostname used for FakeTLS domain fronting in MTProto secrets. */
export function requireDomain(value) {
  const domain = String(value ?? "")
    .trim()
    .toLowerCase();
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (domain.length > 200 || !new RegExp(`^(?:${label}\\.)+${label}$`).test(domain)) {
    throw new UsageError(`Invalid domain '${value}'.`);
  }
  return domain;
}

/** FakeTLS MTProto secret: `ee` + 16 random bytes + hex-encoded fronting domain. */
export function isMtprotoSecret(value) {
  return /^ee[0-9a-f]{32}(?:[0-9a-f]{2})+$/.test(String(value ?? ""));
}
