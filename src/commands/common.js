import net from "node:net";
import { telegramLink } from "../backends/mtproto.js";
import { UsageError } from "../validation.js";

export function requireRoot() {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new UsageError("This command needs root privileges. Run it with sudo.");
  }
}

/** Resolves whether a TCP port can be bound right now. */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

export async function requireFreePort(port) {
  if (!(await isPortFree(port))) {
    throw new UsageError(`Port ${port} is already in use by another process.`);
  }
}

/** Ready-to-paste connection string for a proxy. */
export function connectionString(proxy, host) {
  if (proxy.type === "mtproto") return telegramLink(host, proxy.port, proxy.pass);
  const scheme = proxy.type === "socks5" ? "socks5" : "http";
  const credentials = `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}`;
  return `${scheme}://${credentials}@${host}:${proxy.port}`;
}

export function providerCommand(host, residential) {
  return `npx openfoxy provider ${host}:${residential.gatewayPort}:${residential.providerToken}`;
}
