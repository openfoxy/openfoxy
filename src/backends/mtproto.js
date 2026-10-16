import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, which } from "../system/exec.js";

/** MTProto (Telegram) proxies are served by mtg v2, one daemon per port. */
export const MTG_VERSION = "2.2.8";
export const MTG_BIN = "/usr/local/bin/mtg";
export const DEFAULT_FRONTING_DOMAIN = "www.cloudflare.com";

export const serviceName = (port) => `openfoxy-mtproto-${port}`;

/** FakeTLS secret understood by mtg and Telegram clients: `ee` + 16 random bytes + domain. */
export function generateSecret(domain = DEFAULT_FRONTING_DOMAIN) {
  return `ee${randomBytes(16).toString("hex")}${Buffer.from(domain, "utf8").toString("hex")}`;
}

export function mtgArgv(port, secret) {
  return [MTG_BIN, "simple-run", `0.0.0.0:${port}`, secret];
}

export function telegramLink(host, port, secret) {
  return `tg://proxy?server=${host}&port=${port}&secret=${secret}`;
}

/** Downloads the pinned mtg release when it is not installed yet. */
export async function ensureMtg() {
  if (fs.existsSync(MTG_BIN) || which("mtg")) return;
  const arch = { x64: "amd64", arm64: "arm64" }[os.arch()];
  if (!arch) throw new Error(`mtg has no release for CPU architecture '${os.arch()}'.`);
  const name = `mtg-${MTG_VERSION}-linux-${arch}`;
  const url = `https://github.com/9seconds/mtg/releases/download/v${MTG_VERSION}/${name}.tar.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Downloading mtg failed: HTTP ${response.status}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfoxy-mtg-"));
  try {
    const archive = path.join(workDir, "mtg.tar.gz");
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    run("tar", ["-xzf", archive, "-C", workDir]);
    fs.copyFileSync(path.join(workDir, name, "mtg"), MTG_BIN);
    fs.chmodSync(MTG_BIN, 0o755);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Converges per-port mtg daemons: enabled proxies run, everything else is removed or stopped. */
export function applyMtproto(platform, proxies) {
  const { services } = platform;
  for (const proxy of proxies) {
    const name = serviceName(proxy.port);
    if (proxy.enabled === false) services.stop(name);
    else
      services.installDaemon(
        name,
        `OpenFoxy MTProto proxy on port ${proxy.port}`,
        mtgArgv(proxy.port, proxy.pass),
      );
  }
}
