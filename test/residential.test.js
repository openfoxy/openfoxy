import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { negotiate } from "../src/residential/consumer.js";
import { startMaster } from "../src/residential/master.js";
import { Frame, FrameDecoder, MAX_PAYLOAD, encodeFrame } from "../src/residential/protocol.js";
import { runProvider } from "../src/residential/provider.js";

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

/** Minimal SOCKS5 client; resolves with the connected socket or rejects with the reply code. */
async function socks5Connect(proxyPort, user, pass, host, port) {
  const socket = net.connect(proxyPort, "127.0.0.1");
  await once(socket, "connect");
  const chunks = [];
  let waiting = null;
  socket.on("data", (chunk) => {
    chunks.push(chunk);
    waiting?.();
  });
  const read = async (length) => {
    while (Buffer.concat(chunks).length < length) {
      if (socket.destroyed) throw new Error("closed");
      await Promise.race([new Promise((resolve) => (waiting = resolve)), once(socket, "close")]);
    }
    const all = Buffer.concat(chunks);
    chunks.length = 0;
    if (all.length > length) chunks.push(all.subarray(length));
    return all.subarray(0, length);
  };
  socket.write(Buffer.from([5, 1, 2]));
  assert.deepEqual([...(await read(2))], [5, 2]);
  socket.write(
    Buffer.concat([
      Buffer.from([1, user.length]),
      Buffer.from(user),
      Buffer.from([pass.length]),
      Buffer.from(pass),
    ]),
  );
  const [, authStatus] = await read(2);
  if (authStatus !== 0) throw Object.assign(new Error("auth failed"), { reply: "auth" });
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(
    Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), portBytes]),
  );
  const reply = await read(10);
  if (reply[1] !== 0) {
    socket.destroy();
    throw Object.assign(new Error(`SOCKS reply ${reply[1]}`), { reply: reply[1] });
  }
  socket.removeAllListeners("data");
  return socket;
}

async function rawRequest(port, request) {
  // Like real clients, keep our side open until the server closes the connection.
  const socket = net.connect(port, "127.0.0.1");
  socket.write(request);
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await once(socket, "close");
  return Buffer.concat(chunks).toString("latin1");
}

describe("frame codec", () => {
  it("decodes frames split and coalesced across chunks", () => {
    const wire = Buffer.concat([
      encodeFrame(Frame.DATA, 7, Buffer.from("hello")),
      encodeFrame(Frame.CLOSE, 7),
      encodeFrame(Frame.READY),
    ]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < wire.length; i += 3) frames.push(...decoder.push(wire.subarray(i, i + 3)));
    assert.deepEqual(
      frames.map((f) => [f.type, f.streamId, f.payload.toString()]),
      [
        [Frame.DATA, 7, "hello"],
        [Frame.CLOSE, 7, ""],
        [Frame.READY, 0, ""],
      ],
    );
  });

  it("rejects unknown types and oversized payloads", () => {
    const unknown = Buffer.alloc(9);
    unknown[0] = 99;
    assert.throws(() => new FrameDecoder().push(unknown), /unknown frame type/);
    const huge = Buffer.alloc(9);
    huge[0] = Frame.DATA;
    huge.writeUInt32BE(MAX_PAYLOAD + 1, 5);
    assert.throws(() => new FrameDecoder().push(huge), /too large/);
  });
});

describe("consumer handshake", () => {
  it("parses a SOCKS5 request delivered one byte at a time", async () => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const accepted = once(server, "connection");
    const client = net.connect(server.address().port, "127.0.0.1");
    const [socket] = await accepted;
    const result = negotiate(socket, {
      authenticate: (user, pass) => user === "u" && pass === "p",
      send: (data) => socket.write(data),
    });
    // Every byte in its own segment, except the port arriving coalesced with payload data.
    const bytes = [5, 1, 2, 1, 1, 117, 1, 112, 5, 1, 0, 1, 1, 2, 3, 4];
    for (const byte of bytes) {
      client.write(Buffer.from([byte]));
      await sleep(1);
    }
    client.write(Buffer.from([0, 80, 120]));
    const request = await result;
    assert.equal(request.host, "1.2.3.4");
    assert.equal(request.port, 80);
    assert.equal(request.initialData.toString(), "x");
    client.destroy();
    socket.destroy();
    server.close();
  });
});

describe("residential relay", () => {
  let target, targetPort, master, provider, gatewayPort, proxyPort, config, logs;
  const traffic = {};

  before(async () => {
    // Target service: echoes TCP; also answers HTTP so the forward-proxy path can be tested.
    target = http.createServer((req, res) => {
      res.setHeader("x-saw-proxy-auth", String(Boolean(req.headers["proxy-authorization"])));
      res.end(`path=${req.url}`);
    });
    target.on("connect", () => {});
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    targetPort = target.address().port;

    gatewayPort = await freePort();
    proxyPort = await freePort();
    config = {
      residential: { gatewayPort, providerToken: "test-token" },
      proxies: [
        {
          id: "p1",
          type: "residential",
          user: "res",
          pass: "secret",
          port: proxyPort,
          enabled: true,
          country: null,
          limit: null,
        },
      ],
    };
    logs = [];
    master = startMaster({
      listenHost: "127.0.0.1",
      syncIntervalMs: 50,
      lookupCountry: async () => "US",
      log: (message) => logs.push(message),
      io: {
        loadConfig: () => structuredClone(config),
        loadAccess: () => ({ blocked: {}, allowed: [] }),
        loadTraffic: () => ({}),
        saveTraffic: (value) => Object.assign(traffic, value),
        saveProviders: () => {},
      },
    });
    provider = runProvider({
      host: "127.0.0.1",
      port: gatewayPort,
      token: "test-token",
      quiet: true,
      allowPrivateTargets: true,
    });
    await waitFor(() => master.providerCount === 1);
  });

  after(async () => {
    await provider.stop();
    await master.close();
    target.close();
  });

  it("relays HTTP over SOCKS5 through the provider", async () => {
    const socket = await socks5Connect(proxyPort, "res", "secret", "127.0.0.1", targetPort);
    socket.write("GET /socks HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    await once(socket, "close");
    assert.match(Buffer.concat(chunks).toString(), /path=\/socks/);
  });

  it("rejects wrong SOCKS5 credentials", async () => {
    await assert.rejects(
      socks5Connect(proxyPort, "res", "wrong", "127.0.0.1", targetPort),
      /auth failed/,
    );
  });

  it("tunnels HTTP CONNECT", async () => {
    const response = await rawRequest(
      proxyPort,
      `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from("res:secret").toString("base64")}\r\n\r\n` +
        "GET /tunnel HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
    );
    assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(response, /path=\/tunnel/);
  });

  it("forwards plain HTTP without leaking proxy credentials", async () => {
    const response = await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${targetPort}/plain?q=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from("res:secret").toString("base64")}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    assert.match(response, /path=\/plain\?q=1/);
    assert.match(response, /x-saw-proxy-auth: false/);
  });

  it("answers 407 without credentials and 502 for refused targets", async () => {
    const denied = await rawRequest(proxyPort, `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`);
    assert.match(denied, /^HTTP\/1\.1 407/);
    assert.match(denied, /Proxy-Authenticate: Basic/);

    const closedPort = await freePort();
    const refused = await rawRequest(
      proxyPort,
      `CONNECT 127.0.0.1:${closedPort} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from("res:secret").toString("base64")}\r\n\r\n`,
    );
    assert.match(refused, /^HTTP\/1\.1 502/);
  });

  it("returns 503 when no provider matches the required country", async () => {
    config.proxies[0].country = "DE";
    master.sync();
    const response = await rawRequest(
      proxyPort,
      `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from("res:secret").toString("base64")}\r\n\r\n`,
    );
    config.proxies[0].country = null;
    master.sync();
    assert.match(response, /^HTTP\/1\.1 503/);
  });

  it("relays large payloads intact under back-pressure", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    echo.listen(0, "127.0.0.1");
    await once(echo, "listening");
    const socket = await socks5Connect(
      proxyPort,
      "res",
      "secret",
      "127.0.0.1",
      echo.address().port,
    );
    const payload = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const received = [];
    let total = 0;
    const done = new Promise((resolve) =>
      socket.on("data", (chunk) => {
        received.push(chunk);
        total += chunk.length;
        if (total >= payload.length) resolve();
      }),
    );
    socket.write(payload);
    await done;
    assert.ok(Buffer.concat(received).equals(payload));
    socket.destroy();
    echo.close();
  });

  it("closes the port as soon as the traffic limit is crossed", async () => {
    config.proxies[0].limit = master.usage("p1") + 2048;
    master.sync();
    const socket = await socks5Connect(proxyPort, "res", "secret", "127.0.0.1", targetPort);
    socket.on("error", () => {});
    socket.write(`POST / HTTP/1.1\r\nHost: t\r\nContent-Length: 8192\r\n\r\n${"x".repeat(8192)}`);
    await once(socket, "close");
    assert.ok(logs.some((line) => line.includes("limit")));
    await assert.rejects(socks5Connect(proxyPort, "res", "secret", "127.0.0.1", targetPort));
    assert.ok(traffic.p1.rx + traffic.p1.tx >= config.proxies[0].limit);

    config.proxies[0].limit = null;
    master.sync();
    await sleep(100);
    (await socks5Connect(proxyPort, "res", "secret", "127.0.0.1", targetPort)).destroy();
  });

  it("rejects providers with a wrong token", async () => {
    const intruder = runProvider({
      host: "127.0.0.1",
      port: gatewayPort,
      token: "nope",
      quiet: true,
    });
    await waitFor(() => logs.some((line) => line.includes("Rejected provider")));
    await intruder.stop();
    assert.equal(master.providerCount, 1);
  });
});

describe("provider target policy", () => {
  it("refuses loopback targets unless explicitly allowed", async () => {
    const gatewayPort = await freePort();
    const proxyPort = await freePort();
    const config = {
      residential: { gatewayPort, providerToken: "t" },
      proxies: [
        { id: "x", type: "residential", user: "u", pass: "p", port: proxyPort, enabled: true },
      ],
    };
    const master = startMaster({
      listenHost: "127.0.0.1",
      lookupCountry: async () => null,
      log: () => {},
      io: {
        loadConfig: () => config,
        loadAccess: () => ({ blocked: {}, allowed: [] }),
        loadTraffic: () => ({}),
        saveTraffic: () => {},
        saveProviders: () => {},
      },
    });
    const provider = runProvider({ host: "127.0.0.1", port: gatewayPort, token: "t", quiet: true });
    await waitFor(() => master.providerCount === 1);
    await assert.rejects(
      socks5Connect(proxyPort, "u", "p", "127.0.0.1", 22),
      (error) => error.reply === 0x02,
    );
    await assert.rejects(
      socks5Connect(proxyPort, "u", "p", "localhost", 22),
      (error) => error.reply === 0x02,
    );
    await provider.stop();
    await master.close();
  });
});
