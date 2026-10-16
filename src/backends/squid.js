import fs from "node:fs";
import path from "node:path";
import { run, tryRun, which } from "../system/exec.js";

/** HTTP proxies are served by Squid with basic auth backed by an htpasswd file. */
export const SQUID_DIR = "/etc/squid";
export const SQUID_CONFIG = path.join(SQUID_DIR, "squid.conf");
export const SQUID_PASSWORDS = path.join(SQUID_DIR, "openfoxy.passwd");
const BACKUP = `${SQUID_CONFIG}.openfoxy-orig`;
const MARKER = "# Managed by OpenFoxy";

const AUTH_HELPER_DIRS = ["/usr/lib/squid", "/usr/lib64/squid", "/usr/libexec/squid"];

export function findAuthHelper() {
  for (const dir of AUTH_HELPER_DIRS) {
    const helper = path.join(dir, "basic_ncsa_auth");
    if (fs.existsSync(helper)) return helper;
  }
  throw new Error("Squid's basic_ncsa_auth helper was not found; is Squid installed?");
}

export function renderSquidConfig({ ports, authHelper, passwordFile = SQUID_PASSWORDS }) {
  return [
    MARKER,
    `auth_param basic program ${authHelper} ${passwordFile}`,
    'auth_param basic realm "OpenFoxy"',
    "acl authenticated proxy_auth REQUIRED",
    // Never let proxy users reach services bound to the server itself.
    "http_access deny to_localhost",
    "http_access allow authenticated",
    "http_access deny all",
    ...ports.map((port) => `http_port ${port}`),
    "cache deny all",
    "via off",
    "forwarded_for delete",
    "",
  ].join("\n");
}

/** Rebuilds the password file from scratch so removed users disappear. */
function writePasswords(proxies) {
  const tmp = `${SQUID_PASSWORDS}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, "", { mode: 0o640 });
  const seen = new Set();
  for (const { user, pass } of proxies) {
    if (seen.has(user)) continue;
    seen.add(user);
    run("htpasswd", ["-i", tmp, user], { input: pass });
  }
  // Squid's helper runs unprivileged; give the squid group read access where it exists.
  tryRun("chgrp", ["squid", tmp]) || tryRun("chgrp", ["proxy", tmp]);
  fs.renameSync(tmp, SQUID_PASSWORDS);
}

/** Writes the Squid config and password file for the given enabled HTTP proxies. */
export function writeSquidFiles(proxies) {
  fs.mkdirSync(SQUID_DIR, { recursive: true });
  if (fs.existsSync(SQUID_CONFIG) && !fs.existsSync(BACKUP)) {
    const current = fs.readFileSync(SQUID_CONFIG, "utf8");
    if (!current.startsWith(MARKER)) fs.copyFileSync(SQUID_CONFIG, BACKUP);
  }
  writePasswords(proxies);
  const config = renderSquidConfig({
    ports: proxies.map((p) => p.port),
    authHelper: findAuthHelper(),
  });
  fs.writeFileSync(SQUID_CONFIG, config);
}

/** Converges Squid to the enabled HTTP proxies: reconfigure, start, or stop. */
export function applySquid(platform, proxies) {
  const { services } = platform;
  if (!proxies.length) {
    if (fs.existsSync(SQUID_CONFIG) && fs.readFileSync(SQUID_CONFIG, "utf8").startsWith(MARKER)) {
      services.stop("squid");
    }
    return;
  }
  writeSquidFiles(proxies);
  if (services.isActive("squid")) {
    if (!tryRun(which("squid") ?? "squid", ["-k", "reconfigure"])) services.restart("squid");
  } else if (!services.start("squid")) {
    throw new Error(
      "Squid failed to start; check its logs (journalctl -u squid or /var/log/squid).",
    );
  }
}

/** Removes OpenFoxy's Squid files and restores the distribution config. */
export function removeSquid(platform) {
  platform.services.stop("squid");
  fs.rmSync(SQUID_PASSWORDS, { force: true });
  if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, SQUID_CONFIG);
  else if (
    fs.existsSync(SQUID_CONFIG) &&
    fs.readFileSync(SQUID_CONFIG, "utf8").startsWith(MARKER)
  ) {
    fs.rmSync(SQUID_CONFIG);
  }
}
