import { execFileSync } from "node:child_process";
import { BlockList, isIP } from "node:net";
import os from "node:os";

const PUBLIC_IP_SERVICES = [
  "https://api.ipify.org",
  "https://icanhazip.com",
  "https://ifconfig.me/ip",
];

/** Best-effort public IPv4 lookup used for printing ready-to-copy proxy strings. */
export async function getPublicIp() {
  for (const url of PUBLIC_IP_SERVICES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const ip = (await response.text()).trim();
      if (response.ok && isIP(ip) === 4) return ip;
    } catch {
      // Try the next service.
    }
  }
  return "SERVER_IP";
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : {};
  } catch {
    return {};
  }
}

/**
 * Resolves the ISO country code of a provider IP. Uses IPinfo when `OPENFOXY_IPINFO_TOKEN`
 * (comma-separated tokens allowed) is set, then falls back to keyless public APIs.
 * Returns null when unknown.
 */
export async function lookupCountry(ip) {
  if (!isPublicAddress(ip)) return null;
  const encoded = encodeURIComponent(ip);
  const tokens = (process.env.OPENFOXY_IPINFO_TOKEN ?? "").split(",").map((t) => t.trim());
  const sources = [
    ...tokens
      .filter(Boolean)
      .map((token) => [
        `https://api.ipinfo.io/lite/${encoded}?token=${encodeURIComponent(token)}`,
        (data) => data.country_code,
      ]),
    [`https://ipapi.co/${encoded}/json/`, (data) => data.country_code],
    [`https://ipwho.is/${encoded}`, (data) => (data.success === false ? null : data.country_code)],
  ];
  for (const [url, pick] of sources) {
    const country = String(pick(await fetchJson(url)) ?? "").toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) return country;
  }
  return null;
}

/** Addresses a residential provider must never be asked to reach (its LAN, loopback, …). */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]);
    return !NON_PUBLIC.check(address, "ipv6");
  }
  return !NON_PUBLIC.check(address, "ipv4");
}

/** Interface carrying the default route; Dante needs it as its `external:` address. */
export function defaultInterface() {
  try {
    const route = execFileSync("ip", ["route", "show", "default"], { encoding: "utf8" });
    const device = /\bdev\s+(\S+)/.exec(route)?.[1];
    if (device) return device;
  } catch {
    // iproute2 missing; fall back to the first external IPv4 interface.
  }
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (addresses?.some((a) => a.family === "IPv4" && !a.internal)) return name;
  }
  return "eth0";
}
