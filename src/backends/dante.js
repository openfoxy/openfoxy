import fs from "node:fs";
import { defaultInterface } from "../net-info.js";

/** SOCKS5 proxies are served by Dante, authenticating against OpenFoxy-managed accounts. */
const MARKER = "# Managed by OpenFoxy";

export function renderDanteConfig({ ports, users, external, logOutput = "syslog" }) {
  return [
    MARKER,
    `logoutput: ${logOutput}`,
    ...ports.map((port) => `internal: 0.0.0.0 port = ${port}`),
    `external: ${external}`,
    "socksmethod: username",
    "clientmethod: none",
    "user.privileged: root",
    "user.unprivileged: nobody",
    "client pass {",
    "  from: 0.0.0.0/0 to: 0.0.0.0/0",
    "}",
    // Proxy users must not reach services bound to the server itself.
    "socks block {",
    "  from: 0.0.0.0/0 to: 127.0.0.0/8",
    "  log: error",
    "}",
    "socks pass {",
    "  from: 0.0.0.0/0 to: 0.0.0.0/0",
    "  command: connect",
    `  user: ${users.join(" ")}`,
    "}",
    "",
  ].join("\n");
}

export function writeDanteConfig(file, proxies, { logOutput } = {}) {
  const config = renderDanteConfig({
    ports: proxies.map((p) => p.port),
    users: [...new Set(proxies.map((p) => p.user))],
    external: defaultInterface(),
    logOutput,
  });
  fs.writeFileSync(file, config);
}

/** Converges Dante to the enabled SOCKS5 proxies. */
export function applyDante(platform, proxies) {
  const { services, danteService, danteConfig } = platform;
  if (!proxies.length) {
    services.stop(danteService);
    return;
  }
  writeDanteConfig(danteConfig, proxies);
  if (!services.restart(danteService)) {
    throw new Error(`Dante (${danteService}) failed to start; check the system log.`);
  }
}

export function removeDante(platform) {
  platform.services.stop(platform.danteService);
  const file = platform.danteConfig;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").startsWith(MARKER)) fs.rmSync(file);
}
