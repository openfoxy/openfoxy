import fs from "node:fs";
import { UsageError } from "../validation.js";
import { run, tryRun, which } from "./exec.js";

/**
 * @typedef {object} Platform
 * @property {"alpine"|"debian"|"rhel"} family
 * @property {(packages: string[]) => void} install
 * @property {ServiceManager} services
 * @property {string} danteService  Distro service name for Dante.
 * @property {string} danteConfig   Path of the Dante config file.
 */

function osRelease() {
  try {
    return fs.readFileSync("/etc/os-release", "utf8");
  } catch {
    return "";
  }
}

/** Detects a supported Linux distribution; returns null elsewhere. */
export function detectPlatform() {
  if (process.platform !== "linux") return null;
  const release = osRelease();
  const ids =
    `${/^ID=(.*)$/m.exec(release)?.[1] ?? ""} ${/^ID_LIKE=(.*)$/m.exec(release)?.[1] ?? ""}`
      .replace(/"/g, "")
      .toLowerCase();
  let family = null;
  if (/\balpine\b/.test(ids)) family = "alpine";
  else if (/\b(debian|ubuntu)\b/.test(ids)) family = "debian";
  else if (/\b(rhel|centos|fedora|rocky|almalinux)\b/.test(ids)) family = "rhel";
  if (!family) return null;

  return {
    family,
    install: (packages) => installPackages(family, packages),
    services: detectServiceManager(),
    danteService: family === "debian" ? "danted" : "sockd",
    danteConfig: family === "debian" ? "/etc/danted.conf" : "/etc/sockd.conf",
  };
}

export function requirePlatform() {
  const platform = detectPlatform();
  if (!platform) {
    throw new UsageError(
      "This command requires a supported Linux distribution (Alpine, Debian/Ubuntu, or RHEL-compatible).",
    );
  }
  if (!platform.services) {
    throw new UsageError("No supported service manager found (systemd or OpenRC is required).");
  }
  return platform;
}

/** Distro package names, keyed by a neutral name. */
export const PACKAGES = {
  squid: { alpine: ["squid"], debian: ["squid"], rhel: ["squid"] },
  htpasswd: { alpine: ["apache2-utils"], debian: ["apache2-utils"], rhel: ["httpd-tools"] },
  dante: { alpine: ["dante-server"], debian: ["dante-server"], rhel: ["dante-server"] },
  iptables: { alpine: ["iptables"], debian: ["iptables"], rhel: ["iptables"] },
  iproute: { alpine: ["iproute2"], debian: ["iproute2"], rhel: ["iproute"] },
};

function installPackages(family, packages) {
  if (!packages.length) return;
  if (family === "alpine") {
    run("apk", ["add", "--no-cache", ...packages]);
  } else if (family === "debian") {
    process.env.DEBIAN_FRONTEND = "noninteractive"; // Inherited by apt-get.
    run("apt-get", ["update"]);
    run("apt-get", ["install", "-y", "--no-install-recommends", ...packages]);
  } else {
    const manager = which("dnf") ? "dnf" : "yum";
    // Dante lives in EPEL on RHEL-compatible systems; harmless if already enabled.
    tryRun(manager, ["install", "-y", "epel-release"]);
    run(manager, ["install", "-y", ...packages]);
  }
}

/**
 * Installs packages providing each binary that is missing.
 * @param {Platform} platform
 * @param {Record<string, keyof PACKAGES>} binaries binary name → package key
 */
export function ensureBinaries(platform, binaries) {
  const missing = Object.entries(binaries).filter(([binary]) => !which(binary));
  const packages = [...new Set(missing.flatMap(([, key]) => PACKAGES[key][platform.family]))];
  platform.install(packages);
}

/**
 * @typedef {object} ServiceManager
 * @property {"systemd"|"openrc"} kind
 * @property {(name: string) => boolean} isActive
 * @property {(name: string) => boolean} start
 * @property {(name: string) => boolean} stop
 * @property {(name: string) => boolean} restart
 * @property {(name: string, description: string, argv: string[]) => void} installDaemon
 * @property {(name: string) => void} removeDaemon
 * @property {(name: string) => boolean} hasDaemon
 */

function detectServiceManager() {
  if (fs.existsSync("/run/systemd/system") && which("systemctl")) return systemd();
  if (which("rc-service") && fs.existsSync("/sbin/openrc-run")) return openrc();
  return null;
}

/** systemd unit `ExecStart=` quoting: double quotes, escaped backslashes/quotes, `%` doubled. */
function systemdQuote(arg) {
  return `"${arg.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
}

function systemd() {
  const unitPath = (name) => `/etc/systemd/system/${name}.service`;
  return {
    kind: "systemd",
    isActive: (name) => tryRun("systemctl", ["is-active", "--quiet", name]),
    start: (name) => tryRun("systemctl", ["start", name]),
    stop: (name) => tryRun("systemctl", ["stop", name]),
    restart: (name) => tryRun("systemctl", ["restart", name]),
    hasDaemon: (name) => fs.existsSync(unitPath(name)),
    installDaemon(name, description, argv) {
      const unit = [
        "[Unit]",
        `Description=${description}`,
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        `ExecStart=${argv.map(systemdQuote).join(" ")}`,
        "Restart=on-failure",
        "RestartSec=2",
        "LimitNOFILE=65535",
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "ProtectSystem=full",
        "ProtectHome=read-only",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n");
      const changed = readFileOrNull(unitPath(name)) !== unit;
      fs.writeFileSync(unitPath(name), unit);
      run("systemctl", ["daemon-reload"]);
      run("systemctl", ["enable", name]);
      run("systemctl", [changed ? "restart" : "start", name]);
    },
    removeDaemon(name) {
      tryRun("systemctl", ["disable", "--now", name]);
      fs.rmSync(unitPath(name), { force: true });
      tryRun("systemctl", ["daemon-reload"]);
    },
  };
}

/** POSIX single-quote escaping for OpenRC scripts (evaluated by sh). */
function shellQuote(arg) {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function openrc() {
  const scriptPath = (name) => `/etc/init.d/${name}`;
  const service = (action) => (name) => tryRun("rc-service", [name, action]);
  return {
    kind: "openrc",
    isActive: (name) => tryRun("rc-service", [name, "status"]),
    start: service("start"),
    stop: service("stop"),
    restart: service("restart"),
    hasDaemon: (name) => fs.existsSync(scriptPath(name)),
    installDaemon(name, description, [command, ...args]) {
      const script = [
        "#!/sbin/openrc-run",
        `description=${shellQuote(description)}`,
        `command=${shellQuote(command)}`,
        `command_args=${shellQuote(args.map(shellQuote).join(" "))}`,
        'command_background="yes"',
        `pidfile="/run/${name}.pid"`,
        "",
        "depend() {",
        "  need net",
        "}",
        "",
      ].join("\n");
      const changed = readFileOrNull(scriptPath(name)) !== script;
      fs.writeFileSync(scriptPath(name), script, { mode: 0o755 });
      tryRun("rc-update", ["add", name, "default"]);
      if (changed || !tryRun("rc-service", [name, "status"])) {
        run("rc-service", [name, "restart"]);
      }
    },
    removeDaemon(name) {
      tryRun("rc-service", [name, "stop"]);
      tryRun("rc-update", ["del", name, "default"]);
      fs.rmSync(scriptPath(name), { force: true });
    },
  };
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
