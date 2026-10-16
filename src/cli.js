import fs from "node:fs";
import { parseArgs } from "node:util";
import { runDocker, runProviderCommand, runServeMaster } from "./commands/daemons.js";
import { add, change, remove, setEnabled, uninstall } from "./commands/proxies.js";
import { list, providers, status } from "./commands/reports.js";
import { rule } from "./format.js";
import { UsageError } from "./validation.js";

export const VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const OPTIONS = {
  country: { type: "string" },
  limit: { type: "string" },
  gateway: { type: "string" },
  domain: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  "allow-private-targets": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

/** Which options each command accepts; anything else is rejected rather than ignored. */
const COMMANDS = {
  add: { run: add, options: ["country", "limit", "gateway", "domain"] },
  change: { run: change, options: ["country", "limit"] },
  delete: { run: remove, options: [] },
  start: { run: (args) => setEnabled(args, true), options: [] },
  stop: { run: (args) => setEnabled(args, false), options: [] },
  list: { run: list, options: [] },
  status: { run: status, options: [] },
  providers: { run: providers, options: [] },
  provider: { run: runProviderCommand, options: ["quiet", "allow-private-targets"] },
  uninstall: { run: uninstall, options: [] },
  docker: { run: runDocker, options: ["country", "limit", "gateway", "domain"] },
  "serve-master": { run: runServeMaster, options: [] },
};

export function helpText() {
  return `
🦊 OpenFoxy v${VERSION}: distributed proxy manager
${rule()}

Usage:
  openfoxy add <user> <pass> <port> [protocol] [options]
      --country=XX      residential: only use providers from this country
      --limit=SIZE      residential: traffic cap such as 500MB or 2GB
      --gateway=PORT    residential: provider gateway port (default 9000)
      --domain=HOST     mtproto: FakeTLS fronting domain
  openfoxy change <user> [newpass] [--limit=SIZE|0] [--country=XX|""]
  openfoxy delete <user> <port>
  openfoxy stop [port|protocol]       Disable proxies (all when omitted)
  openfoxy start [port|protocol]      Re-enable proxies (all when omitted)
  openfoxy list                       Show proxies and connection strings
  openfoxy status                     Services, traffic, and provider pool
  openfoxy uninstall                  Remove all proxies, services, and data

Protocols:
  http          Squid web proxy (default)
  socks5        Dante SOCKS5 proxy
  mtproto       Telegram proxy (mtg); pass an ee… secret or any word to generate one
  residential   SOCKS5 + HTTP proxy relayed through provider machines

Residential network:
  openfoxy provider <gateway-host>:<port>:<token> [--quiet] [--allow-private-targets]
  openfoxy providers                  List connected, banned, and blocked providers
  openfoxy providers block <ip> [reason]
  openfoxy providers unblock <ip>
  openfoxy providers allow <ip>       Only allowlisted providers may join once any exist
  openfoxy providers disallow <ip>

Docker:
  docker run -d -p <port>:<port> ghcr.io/openfoxy/openfoxy <user> <pass> <port> [protocol]

Options:
  -h, --help        Show this help
  -v, --version     Print the version
`;
}

function parse(argv) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message, { exitCode: 2 });
  }
}

/**
 * Runs the CLI and resolves with the process exit code. Long-running commands (provider,
 * serve-master, docker) resolve once started; their servers keep the process alive.
 */
export async function main(argv) {
  try {
    const { values, positionals } = parse(argv);
    const [name, ...args] = positionals;
    if (values.version || name === "version") {
      console.log(VERSION);
      return 0;
    }
    if (values.help || !name || name === "help") {
      console.log(helpText());
      return 0;
    }
    const command = COMMANDS[name];
    if (!command)
      throw new UsageError(`Unknown command '${name}'. Run 'openfoxy --help'.`, { exitCode: 2 });

    const unsupported = Object.keys(values).filter((option) => !command.options.includes(option));
    if (unsupported.length) {
      throw new UsageError(`'${name}' does not accept --${unsupported.join(", --")}.`, {
        exitCode: 2,
      });
    }
    await command.run(args, values);
    return 0;
  } catch (error) {
    console.error(`\n❌ ${error.message}\n`);
    if (error instanceof UsageError) return error.exitCode;
    if (process.env.OPENFOXY_DEBUG) console.error(error);
    return 1;
  }
}
