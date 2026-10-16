import { spawn } from "node:child_process";
import { writeDanteConfig } from "../backends/dante.js";
import { mtgArgv } from "../backends/mtproto.js";
import { writeSquidFiles } from "../backends/squid.js";
import { color } from "../format.js";
import { getPublicIp } from "../net-info.js";
import { startMaster } from "../residential/master.js";
import { runProvider } from "../residential/provider.js";
import * as store from "../store.js";
import { which } from "../system/exec.js";
import { setProxyUser } from "../system/users.js";
import { UsageError, requirePort } from "../validation.js";
import { connectionString, providerCommand } from "./common.js";
import { parseAddArgs } from "./proxies.js";

function onShutdown(handler) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      Promise.resolve(handler()).finally(() => process.exit(0));
    });
  }
}

/** `provider <host>:<port>:<token>` — run a residential exit node. */
export function runProviderCommand([address], options) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+):(.+)$/.exec(address ?? "");
  if (!match) {
    throw new UsageError("Usage: openfoxy provider <gateway-host>:<port>:<token> [--quiet]", {
      exitCode: 2,
    });
  }
  const provider = runProvider({
    host: match[1].replace(/^\[|\]$/g, ""),
    port: requirePort(match[2], "gateway port"),
    token: match[3],
    quiet: options.quiet ?? false,
    allowPrivateTargets: options["allow-private-targets"] ?? false,
  });
  onShutdown(() => provider.stop());
}

/** `serve-master` — the residential master daemon (started by the service manager). */
export function runServeMaster() {
  const master = startMaster();
  onShutdown(() => master.close());
}

/** Runs a foreground server as the container's main process, forwarding stop signals. */
function runForeground(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`❌ ${command}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

/**
 * Container entry point: `docker run … <user> <pass> <port> [protocol]`. Exactly one proxy
 * runs in the foreground; the image ships every backend binary.
 */
export async function runDocker(args, options) {
  const { proxy, gatewayPort } = parseAddArgs(args, options);
  const ip = await getPublicIp();
  console.log(`\n🐳 OpenFoxy ${proxy.type.toUpperCase()} proxy on port ${proxy.port}\n`);

  if (proxy.type === "http") {
    writeSquidFiles([proxy]);
    console.log(`   🌐 ${connectionString(proxy, ip)}\n`);
    runForeground("squid", ["-N", "-d", "1"]);
  } else if (proxy.type === "socks5") {
    setProxyUser(proxy.user, proxy.pass);
    writeDanteConfig("/etc/sockd.conf", [proxy], { logOutput: "stderr" });
    console.log(`   🌐 ${connectionString(proxy, ip)}\n`);
    runForeground(which("sockd") ?? "sockd", ["-f", "/etc/sockd.conf"]);
  } else if (proxy.type === "mtproto") {
    console.log(`   🌐 ${color.green(connectionString(proxy, ip))}\n`);
    const [command, ...rest] = mtgArgv(proxy.port, proxy.pass);
    runForeground(which("mtg") ?? command, rest);
  } else {
    const residential = {
      gatewayPort: gatewayPort ?? store.DEFAULT_GATEWAY_PORT,
      providerToken: store.loadConfig().residential?.providerToken ?? store.newProviderToken(),
    };
    if (residential.gatewayPort === proxy.port) {
      throw new UsageError("The gateway port must differ from the proxy port.");
    }
    store.saveConfig({ proxies: [proxy], residential });
    console.log(`   🌐 Proxy:    ${connectionString(proxy, ip)}  (HTTP and SOCKS5)`);
    console.log(`   🏠 Provider: ${color.cyan(providerCommand(ip, residential))}\n`);
    runServeMaster();
  }
}
