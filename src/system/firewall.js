import { capture, tryRun, which } from "./exec.js";

/**
 * Opens proxy ports in the host firewall. iptables ACCEPT rules tagged `openfoxy` double as
 * traffic counters for the Squid, Dante, and MTProto ports. ufw/firewalld are configured
 * too when they are active, but never installed or enabled by OpenFoxy.
 */
const COMMENT = "openfoxy";

const TAG = ["-m", "comment", "--comment", COMMENT, "-j", "ACCEPT"];
const inputRule = (port) => ["INPUT", "-p", "tcp", "--dport", String(port), ...TAG];
const outputRule = (port) => ["OUTPUT", "-p", "tcp", "--sport", String(port), ...TAG];

function ufwActive() {
  return Boolean(which("ufw")) && /Status: active/.test(capture("ufw", ["status"]) ?? "");
}

function firewalldActive() {
  return Boolean(which("firewall-cmd")) && tryRun("firewall-cmd", ["--state"]);
}

export function openPort(port) {
  if (which("iptables")) {
    for (const rule of [inputRule(port), outputRule(port)]) {
      const [chain, ...spec] = rule;
      if (!tryRun("iptables", ["-C", chain, ...spec]))
        tryRun("iptables", ["-I", chain, "1", ...spec]);
    }
  }
  if (ufwActive()) tryRun("ufw", ["allow", `${port}/tcp`]);
  if (firewalldActive()) {
    tryRun("firewall-cmd", ["--permanent", `--add-port=${port}/tcp`]);
    tryRun("firewall-cmd", ["--reload"]);
  }
}

export function closePort(port) {
  if (which("iptables")) {
    for (const rule of [inputRule(port), outputRule(port)]) {
      // Remove every copy in case the rule was added more than once.
      while (tryRun("iptables", ["-D", ...rule]));
    }
  }
  if (ufwActive()) tryRun("ufw", ["delete", "allow", `${port}/tcp`]);
  if (firewalldActive()) {
    tryRun("firewall-cmd", ["--permanent", `--remove-port=${port}/tcp`]);
    tryRun("firewall-cmd", ["--reload"]);
  }
}

/**
 * Reads byte counters of OpenFoxy rules.
 * @returns {Map<number, { rx: number, tx: number }>} port → bytes received / sent
 */
export function readPortCounters() {
  const counters = new Map();
  const counter = (port) => {
    if (!counters.has(port)) counters.set(port, { rx: 0, tx: 0 });
    return counters.get(port);
  };
  for (const [chain, field, key] of [
    ["INPUT", "dpt", "rx"],
    ["OUTPUT", "spt", "tx"],
  ]) {
    const listing = capture("iptables", ["-nvxL", chain]) ?? "";
    for (const line of listing.split("\n")) {
      if (!line.includes(`/* ${COMMENT} */`)) continue;
      const bytes = /^\s*\d+\s+(\d+)/.exec(line)?.[1];
      const port = new RegExp(`\\b${field}:(\\d+)\\b`).exec(line)?.[1];
      if (bytes && port) counter(Number(port))[key] += Number(bytes);
    }
  }
  return counters;
}
