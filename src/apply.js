import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { applyDante } from "./backends/dante.js";
import { applyMtproto } from "./backends/mtproto.js";
import { applySquid } from "./backends/squid.js";

export const RESIDENTIAL_SERVICE = "openfoxy-residential";

/** Absolute path of the CLI entry point, used as the residential daemon's command. */
const ENTRY_POINT = fs.realpathSync(fileURLToPath(new URL("../bin/openfoxy.js", import.meta.url)));

const enabled = (proxies, type) => proxies.filter((p) => p.type === type && p.enabled !== false);

/**
 * Converges system services to `config` for the given proxy types. Each backend is
 * idempotent, so applying an unchanged config is safe.
 *
 * @param {import("./system/platform.js").Platform} platform
 * @param {import("./store.js").Config} config
 * @param {Iterable<string>} types
 */
export function applyConfig(platform, config, types) {
  const wanted = new Set(types);
  if (wanted.has("http")) applySquid(platform, enabled(config.proxies, "http"));
  if (wanted.has("socks5")) applyDante(platform, enabled(config.proxies, "socks5"));
  if (wanted.has("mtproto")) {
    applyMtproto(
      platform,
      config.proxies.filter((p) => p.type === "mtproto"),
    );
  }
  if (wanted.has("residential")) applyResidential(platform, config);
}

/**
 * One master daemon serves every residential proxy and re-reads the config by itself, so it
 * only needs to exist while residential proxies do.
 */
function applyResidential(platform, config) {
  const { services } = platform;
  if (!config.proxies.some((p) => p.type === "residential")) {
    if (services.hasDaemon(RESIDENTIAL_SERVICE)) services.removeDaemon(RESIDENTIAL_SERVICE);
    return;
  }
  services.installDaemon(RESIDENTIAL_SERVICE, "OpenFoxy residential master", [
    process.execPath,
    ENTRY_POINT,
    "serve-master",
  ]);
}
