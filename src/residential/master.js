import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { formatBytes } from "../format.js";
import { lookupCountry as defaultLookupCountry } from "../net-info.js";
import * as store from "../store.js";
import { normalizeIp } from "../validation.js";
import { negotiate } from "./consumer.js";
import { Frame, PROTOCOL_VERSION, decodeHello, encodeTarget } from "./protocol.js";
import { Tunnel } from "./tunnel.js";

const AUTH_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const COUNTRY_CACHE_MS = 6 * 60 * 60 * 1000;
/** A provider that drops off abruptly this many times within the window is banned for a while. */
const ABRUPT_DISCONNECT_LIMIT = 5;
const ABRUPT_DISCONNECT_WINDOW_MS = 10 * 60 * 1000;
const BAN_DURATION_MS = 60 * 60 * 1000;

const defaultIo = {
  loadConfig: store.loadConfig,
  loadAccess: store.loadAccess,
  loadTraffic: store.loadTraffic,
  saveTraffic: (traffic) => store.writeJson(store.paths.traffic, traffic),
  saveProviders: (state) => store.writeJson(store.paths.providers, state),
};

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

/** Constant-time string comparison (hashing equalises lengths). */
export function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

function relayError(code) {
  return Object.assign(new Error(code), { code });
}

/** One authenticated provider connection and the streams it carries. */
class ProviderLink {
  #nextStreamId = 1;
  pending = new Map();
  graceful = false;
  kicked = false;

  constructor({ ip, country, tunnel }) {
    this.id = randomBytes(4).toString("hex");
    this.ip = ip;
    this.country = country;
    this.tunnel = tunnel;
    this.connectedAt = new Date().toISOString();
  }

  get load() {
    return this.tunnel.streamCount + this.pending.size;
  }

  /** Asks the provider to open a TCP connection; resolves with the stream id once connected. */
  open(host, port) {
    if (!host || Buffer.byteLength(host) > 253) return Promise.reject(relayError("ENOTFOUND"));
    const streamId = this.#nextStreamId;
    this.#nextStreamId = streamId >= 0xffff_ffff ? 1 : streamId + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(streamId);
        this.tunnel.send(Frame.CLOSE, streamId);
        reject(relayError("ETIMEDOUT"));
      }, CONNECT_TIMEOUT_MS);
      this.pending.set(streamId, {
        resolve: () => {
          clearTimeout(timer);
          resolve(streamId);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.tunnel.send(Frame.CONNECT, streamId, encodeTarget(host, port));
    });
  }

  handleFrame({ type, streamId, payload }) {
    const pending = this.pending.get(streamId);
    if (type === Frame.SHUTDOWN) {
      this.graceful = true;
    } else if (type === Frame.CONNECTED) {
      this.pending.delete(streamId);
      if (pending) pending.resolve();
      else this.tunnel.send(Frame.CLOSE, streamId); // The consumer gave up already.
    } else if (type === Frame.CLOSE && pending) {
      this.pending.delete(streamId);
      pending.reject(relayError(payload.toString("utf8") || "ECONNREFUSED"));
    }
  }

  failPending() {
    for (const { reject } of this.pending.values()) reject(relayError("ECONNRESET"));
    this.pending.clear();
  }

  kick() {
    this.kicked = true;
    this.tunnel.destroy();
  }
}

/**
 * Residential master: accepts providers on the gateway port and serves consumers on every
 * enabled residential proxy port, relaying each consumer connection through a provider.
 * Configuration is re-read periodically, so CLI changes apply without a restart.
 *
 * @param {object} [options]
 * @param {number} [options.syncIntervalMs]
 * @param {string} [options.listenHost] Bind address; defaults to all interfaces.
 * @param {(ip: string) => Promise<string|null>} [options.lookupCountry]
 * @param {(message: string) => void} [options.log]
 * @param {typeof defaultIo} [options.io]
 */
export function startMaster({
  syncIntervalMs = 2000,
  listenHost,
  lookupCountry = defaultLookupCountry,
  log = console.log,
  io = defaultIo,
} = {}) {
  /** @type {Set<ProviderLink>} */
  const providers = new Set();
  /** @type {Map<number, { server: net.Server, sockets: Set<net.Socket>, proxyId: string }>} */
  const consumers = new Map();
  const traffic = new Map(Object.entries(safeLoad(io.loadTraffic, {})));
  const disconnects = new Map();
  const bans = new Map();
  const countryCache = new Map();
  let config = { proxies: [], residential: null };
  let access = { blocked: {}, allowed: [] };
  let proxiesById = new Map();
  let gateway = null;
  let gatewayPort = null;
  let lastTrafficJson = "";
  let lastProvidersJson = "";
  let closed = false;

  function safeLoad(loader, fallback) {
    try {
      return loader();
    } catch (error) {
      log(`⚠️  ${error.message}`);
      return fallback;
    }
  }

  // ---------------------------------------------------------------- traffic & limits

  function usage(proxyId) {
    const counters = traffic.get(proxyId);
    return counters ? counters.rx + counters.tx : 0;
  }

  function overLimit(proxy) {
    return Boolean(proxy.limit) && usage(proxy.id) >= proxy.limit;
  }

  function account(proxyId, rx, tx) {
    let counters = traffic.get(proxyId);
    if (!counters) traffic.set(proxyId, (counters = { rx: 0, tx: 0 }));
    counters.rx += rx;
    counters.tx += tx;
    const proxy = proxiesById.get(proxyId);
    if (proxy && overLimit(proxy) && consumers.get(proxy.port)?.proxyId === proxyId) {
      closeConsumer(proxy.port, `limit of ${formatBytes(proxy.limit)} reached`);
    }
  }

  // ---------------------------------------------------------------- consumers

  function openConsumer(proxy) {
    const entry = { server: net.createServer(), sockets: new Set(), proxyId: proxy.id };
    entry.server.on("connection", (socket) => {
      entry.sockets.add(socket);
      socket.on("close", () => entry.sockets.delete(socket));
      handleConsumer(proxy.id, socket).catch((error) => {
        log(`⚠️  Consumer error on port ${proxy.port}: ${error.message}`);
        socket.destroy();
      });
    });
    entry.server.on("error", (error) => {
      log(`⚠️  Cannot serve residential port ${proxy.port}: ${error.message}`);
      if (consumers.get(proxy.port) === entry) consumers.delete(proxy.port);
      entry.server.close();
    });
    entry.server.listen(proxy.port, listenHost);
    consumers.set(proxy.port, entry);
  }

  function closeConsumer(port, reason) {
    const entry = consumers.get(port);
    if (!entry) return;
    consumers.delete(port);
    entry.server.close();
    for (const socket of entry.sockets) socket.destroy();
    if (reason) log(`⛔ Port ${port} closed: ${reason}`);
  }

  async function handleConsumer(proxyId, socket) {
    const proxy = proxiesById.get(proxyId);
    if (!proxy || proxy.enabled === false || overLimit(proxy)) return socket.destroy();

    socket.setNoDelay(true);
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => account(proxyId, chunk.length, 0));
    const send = (data) => {
      if (socket.destroyed) return;
      account(proxyId, 0, Buffer.byteLength(data));
      socket.write(data);
    };

    let request;
    try {
      request = await negotiate(socket, {
        send,
        authenticate: (user, pass) => {
          const current = proxiesById.get(proxyId);
          // Evaluate both comparisons so timing does not reveal which one failed.
          const userOk = safeEqual(user, current?.user ?? "");
          const passOk = safeEqual(pass, current?.pass ?? "");
          return Boolean(current) && userOk && passOk;
        },
      });
    } catch {
      socket.end();
      return;
    }

    const provider = pickProvider(proxiesById.get(proxyId)?.country ?? null);
    if (!provider) {
      request.reject("ENOPROVIDER");
      socket.end();
      return;
    }

    let streamId;
    try {
      streamId = await provider.open(request.host, request.port);
    } catch (error) {
      if (!socket.destroyed) {
        request.reject(error.code);
        socket.end();
      }
      return;
    }
    if (socket.destroyed) {
      provider.tunnel.closeStream(streamId);
      return;
    }
    socket.setTimeout(0);
    request.accept();
    provider.tunnel.attach(streamId, socket, {
      initialData: request.initialData,
      onWrite: (bytes) => account(proxyId, 0, bytes),
    });
  }

  // ---------------------------------------------------------------- providers

  function pickProvider(country) {
    let best = [];
    for (const link of providers) {
      if (country && link.country !== country) continue;
      if (!best.length || link.load < best[0].load) best = [link];
      else if (link.load === best[0].load) best.push(link);
    }
    return best.length ? best[Math.floor(Math.random() * best.length)] : null;
  }

  function admissible(ip) {
    const ban = bans.get(ip);
    if (ban && ban.until > Date.now()) return false;
    return store.isProviderAllowed(access, ip);
  }

  function recordAbruptDisconnect(ip) {
    const now = Date.now();
    let record = disconnects.get(ip);
    if (!record || now - record.since > ABRUPT_DISCONNECT_WINDOW_MS) {
      record = { count: 0, since: now };
      disconnects.set(ip, record);
    }
    record.count += 1;
    if (record.count >= ABRUPT_DISCONNECT_LIMIT) {
      disconnects.delete(ip);
      bans.set(ip, { until: now + BAN_DURATION_MS, reason: `${record.count} abrupt disconnects` });
      log(`⚠️  Provider ${ip} banned for 1 hour after ${record.count} abrupt disconnects`);
    }
  }

  async function resolveCountry(ip) {
    const cached = countryCache.get(ip);
    if (cached && Date.now() - cached.at < COUNTRY_CACHE_MS) return cached.country;
    const country = (await lookupCountry(ip).catch(() => null)) ?? "UNKNOWN";
    countryCache.set(ip, { country, at: Date.now() });
    return country;
  }

  function handleProviderSocket(socket) {
    const ip = normalizeIp(socket.remoteAddress);
    if (!ip || !admissible(ip)) return socket.destroy();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(AUTH_TIMEOUT_MS, () => socket.destroy());

    const tunnel = new Tunnel(socket);
    tunnel.on("protocolError", (error) => log(`⚠️  Provider ${ip}: ${error.message}`));
    let link = null;
    let authenticating = false;

    tunnel.on("frame", async (frame) => {
      if (link) return link.handleFrame(frame);
      if (authenticating || frame.type !== Frame.HELLO) return tunnel.destroy();
      authenticating = true;

      let hello;
      try {
        hello = decodeHello(frame.payload);
      } catch {
        return tunnel.destroy();
      }
      const token = config.residential?.providerToken;
      if (hello.version !== PROTOCOL_VERSION || !token || !safeEqual(hello.token, token)) {
        log(`🚫 Rejected provider ${ip}: invalid token or protocol version`);
        return tunnel.destroy();
      }
      socket.setTimeout(0);
      const country = await resolveCountry(ip);
      if (tunnel.closed) return;

      link = new ProviderLink({ ip, country, tunnel });
      providers.add(link);
      tunnel.send(Frame.READY);
      log(`🏠 Provider ${link.id} connected from ${ip} [${country}]`);
      publishState();
    });

    tunnel.on("close", () => {
      if (!link) return;
      providers.delete(link);
      link.failPending();
      if (!link.graceful && !link.kicked) recordAbruptDisconnect(ip);
      log(`👋 Provider ${link.id} (${ip}) disconnected${link.graceful ? " gracefully" : ""}`);
      publishState();
    });
  }

  function bindGateway(port) {
    if (gateway) {
      gateway.close();
      gateway = null;
    }
    gatewayPort = port;
    if (port === null) return;
    const server = net.createServer(handleProviderSocket);
    server.on("error", (error) => {
      log(`⚠️  Gateway port ${port}: ${error.message}`);
      if (gateway === server) {
        gateway = null;
        gatewayPort = null; // Retried on the next sync.
      }
    });
    server.listen(port, listenHost, () => log(`🚀 Gateway listening on port ${port}`));
    gateway = server;
  }

  // ---------------------------------------------------------------- sync loop

  function publishState() {
    const now = Date.now();
    for (const [ip, ban] of bans) if (ban.until <= now) bans.delete(ip);

    const trafficJson = JSON.stringify(Object.fromEntries(traffic));
    if (trafficJson !== lastTrafficJson) {
      lastTrafficJson = trafficJson;
      safeLoad(() => io.saveTraffic(Object.fromEntries(traffic)));
    }
    const state = {
      providers: [...providers].map((link) => ({
        id: link.id,
        ip: link.ip,
        country: link.country,
        rx: link.tunnel.socket.bytesRead,
        tx: link.tunnel.socket.bytesWritten,
        streams: link.tunnel.streamCount,
        connectedAt: link.connectedAt,
      })),
      bans: [...bans].map(([ip, ban]) => ({
        ip,
        reason: ban.reason,
        until: new Date(ban.until).toISOString(),
      })),
    };
    const providersJson = JSON.stringify(state);
    if (providersJson !== lastProvidersJson) {
      lastProvidersJson = providersJson;
      safeLoad(() => io.saveProviders(state));
    }
  }

  function sync() {
    if (closed) return;
    config = safeLoad(io.loadConfig, config);
    access = safeLoad(io.loadAccess, access);
    const residential = config.proxies.filter((proxy) => proxy.type === "residential");
    proxiesById = new Map(residential.map((proxy) => [proxy.id, proxy]));

    const wantedGateway = residential.length ? (config.residential?.gatewayPort ?? null) : null;
    if (wantedGateway !== gatewayPort) bindGateway(wantedGateway);

    for (const link of providers) if (!admissible(link.ip)) link.kick();

    const wanted = new Map(
      residential
        .filter((proxy) => proxy.enabled !== false && !overLimit(proxy))
        .map((proxy) => [proxy.port, proxy]),
    );
    for (const [port, entry] of consumers) {
      if (wanted.get(port)?.id !== entry.proxyId) closeConsumer(port);
    }
    for (const [port, proxy] of wanted) if (!consumers.has(port)) openConsumer(proxy);

    for (const id of traffic.keys()) if (!proxiesById.has(id)) traffic.delete(id);
    publishState();
  }

  sync();
  const timer = setInterval(sync, syncIntervalMs);

  return {
    get gatewayPort() {
      return gatewayPort;
    },
    get providerCount() {
      return providers.size;
    },
    sync,
    usage,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      publishState();
      for (const port of [...consumers.keys()]) closeConsumer(port);
      for (const link of providers) link.kick();
      if (gateway) await new Promise((resolve) => gateway.close(resolve));
    },
  };
}
