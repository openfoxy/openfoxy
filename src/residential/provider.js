import dns from "node:dns";
import net from "node:net";
import { isPublicAddress } from "../net-info.js";
import { Frame, decodeTarget, encodeHello } from "./protocol.js";
import { Tunnel } from "./tunnel.js";

const READY_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 12_000;
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;

function forbidden(host) {
  return Object.assign(new Error(`${host} is not a public address`), { code: "EFORBIDDEN" });
}

/**
 * DNS lookup that drops loopback, private, and link-local results, so consumers can only
 * reach the public internet through this machine, never its LAN or local services.
 * Filtering inside the lookup keeps Node's Happy Eyeballs connection logic intact.
 */
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const allowed = addresses.filter(({ address }) => isPublicAddress(address));
    if (!allowed.length) return callback(forbidden(hostname));
    if (options.all) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
}

/**
 * Residential exit node: keeps a connection to the master gateway and opens the TCP
 * connections the master requests. Reconnects with capped exponential backoff.
 *
 * @param {{ host: string, port: number, token: string, quiet?: boolean,
 *   allowPrivateTargets?: boolean, log?: (message: string) => void }} options
 */
export function runProvider({
  host,
  port,
  token,
  quiet = false,
  allowPrivateTargets = false,
  log = console.log,
}) {
  const say = (message) => quiet || log(message);
  const connecting = new Map();
  let tunnel = null;
  let retryDelay = MIN_RETRY_MS;
  let retryTimer = null;
  let stopped = false;

  function openTarget(streamId, payload) {
    let target;
    try {
      target = decodeTarget(payload);
    } catch {
      tunnel.closeStream(streamId, "EINVAL");
      return;
    }
    if (!allowPrivateTargets && net.isIP(target.host) && !isPublicAddress(target.host)) {
      tunnel.closeStream(streamId, "EFORBIDDEN");
      return;
    }

    const current = tunnel;
    const socket = net.connect({
      host: target.host,
      port: target.port,
      lookup: allowPrivateTargets ? undefined : publicOnlyLookup,
    });
    connecting.set(streamId, socket);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      socket.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })),
    );
    socket.once("connect", () => {
      if (!connecting.delete(streamId) || current.closed) return socket.destroy();
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.pause();
      current.send(Frame.CONNECTED, streamId);
      current.attach(streamId, socket);
    });
    socket.once("error", (error) => {
      if (connecting.delete(streamId)) current.closeStream(streamId, error.code ?? "ECONNREFUSED");
    });
  }

  function connect() {
    retryTimer = null;
    say(`⏳ Connecting to gateway ${host}:${port}...`);
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    tunnel = new Tunnel(socket);
    const current = tunnel;
    const readyTimer = setTimeout(() => socket.destroy(), READY_TIMEOUT_MS);

    socket.once("connect", () => current.send(Frame.HELLO, 0, encodeHello(token)));
    current.on("frame", ({ type, streamId, payload }) => {
      if (type === Frame.READY) {
        clearTimeout(readyTimer);
        retryDelay = MIN_RETRY_MS;
        say("✅ Connected. Relaying traffic for the gateway.");
      } else if (type === Frame.CONNECT) {
        openTarget(streamId, payload);
      } else if (type === Frame.CLOSE) {
        connecting.get(streamId)?.destroy();
        connecting.delete(streamId);
      }
    });
    current.on("close", () => {
      clearTimeout(readyTimer);
      for (const pending of connecting.values()) pending.destroy();
      connecting.clear();
      if (stopped) return;
      say(`❌ Disconnected. Reconnecting in ${retryDelay / 1000}s...`);
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    });
  }

  connect();

  return {
    /** Tells the gateway this is a graceful disconnect (no penalty), then closes. */
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      if (!tunnel || tunnel.closed) return Promise.resolve();
      const current = tunnel;
      return new Promise((resolve) => {
        current.on("close", resolve);
        current.send(Frame.SHUTDOWN);
        current.socket.end();
        setTimeout(() => current.destroy(), 1000).unref();
      });
    },
  };
}
