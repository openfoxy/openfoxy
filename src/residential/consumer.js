import { isIPv6 } from "node:net";
import { SocketReader } from "./socket-reader.js";

/**
 * Consumer-side handshakes for residential proxy ports. One port serves SOCKS5 (detected by
 * its 0x05 version byte), HTTP CONNECT tunnels, and plain `http://` forward-proxy requests.
 */

const MAX_HTTP_HEAD = 64 * 1024;
const CRLF2 = Buffer.from("\r\n\r\n");

/** How a failed relay is reported to the consumer, by error code. */
const FAILURES = {
  EFORBIDDEN: { socks: 0x02, http: "403 Forbidden" },
  ENOPROVIDER: { socks: 0x01, http: "503 Service Unavailable" },
  ECONNREFUSED: { socks: 0x05, http: "502 Bad Gateway" },
  ENETUNREACH: { socks: 0x03, http: "502 Bad Gateway" },
  EHOSTUNREACH: { socks: 0x04, http: "502 Bad Gateway" },
  ENOTFOUND: { socks: 0x04, http: "502 Bad Gateway" },
  EAI_AGAIN: { socks: 0x04, http: "502 Bad Gateway" },
  ETIMEDOUT: { socks: 0x04, http: "504 Gateway Timeout" },
};
const DEFAULT_FAILURE = { socks: 0x01, http: "502 Bad Gateway" };

export class HandshakeError extends Error {
  name = "HandshakeError";
}

/**
 * Reads and authenticates a consumer request.
 *
 * @param {import("node:net").Socket} socket
 * @param {{ authenticate: (user: string, pass: string) => boolean, send: (data: Buffer|string) => void }} options
 * @returns {Promise<{ protocol: "socks5"|"http", host: string, port: number, initialData: Buffer,
 *   accept: () => void, reject: (code?: string) => void }>}
 *   `initialData` holds bytes to forward once the stream opens. The socket is left paused.
 */
export async function negotiate(socket, { authenticate, send }) {
  const reader = new SocketReader(socket);
  try {
    const [version] = await reader.peek(1);
    const request =
      version === 0x05
        ? await negotiateSocks5(reader, { authenticate, send })
        : await negotiateHttp(reader, { authenticate, send });
    const leftover = reader.release();
    return {
      ...request,
      initialData: Buffer.concat([request.initialData ?? Buffer.alloc(0), leftover]),
    };
  } catch (error) {
    reader.release();
    throw error;
  }
}

async function negotiateSocks5(reader, { authenticate, send }) {
  const [, methodCount] = await reader.read(2);
  const methods = await reader.read(methodCount);
  if (!methods.includes(0x02)) {
    send(Buffer.from([0x05, 0xff]));
    throw new HandshakeError("SOCKS5 client does not offer username/password authentication");
  }
  send(Buffer.from([0x05, 0x02]));

  // RFC 1929 username/password sub-negotiation.
  const [authVersion, userLength] = await reader.read(2);
  const user = (await reader.read(userLength)).toString("utf8");
  const [passLength] = await reader.read(1);
  const pass = (await reader.read(passLength)).toString("utf8");
  if (authVersion !== 0x01 || !authenticate(user, pass)) {
    send(Buffer.from([0x01, 0x01]));
    throw new HandshakeError("SOCKS5 authentication failed");
  }
  send(Buffer.from([0x01, 0x00]));

  const [, command, , addressType] = await reader.read(4);
  let host;
  if (addressType === 0x01) host = [...(await reader.read(4))].join(".");
  else if (addressType === 0x03) host = (await reader.read((await reader.read(1))[0])).toString();
  else if (addressType === 0x04) host = formatIPv6(await reader.read(16));
  else {
    send(socksReply(0x08));
    throw new HandshakeError("unsupported SOCKS5 address type");
  }
  const port = (await reader.read(2)).readUInt16BE(0);
  if (command !== 0x01) {
    send(socksReply(0x07));
    throw new HandshakeError("only the SOCKS5 CONNECT command is supported");
  }

  return {
    protocol: "socks5",
    host,
    port,
    accept: () => send(socksReply(0x00)),
    reject: (code) => send(socksReply((FAILURES[code] ?? DEFAULT_FAILURE).socks)),
  };
}

async function negotiateHttp(reader, { authenticate, send }) {
  let head;
  try {
    head = (await reader.readUntil(CRLF2, MAX_HTTP_HEAD)).toString("latin1");
  } catch (error) {
    if (error.message === "message too large")
      send(httpResponse("431 Request Header Fields Too Large"));
    throw error;
  }
  const [requestLine, ...headerLines] = head.slice(0, -4).split("\r\n");
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (!match) {
    send(httpResponse("400 Bad Request"));
    throw new HandshakeError("malformed HTTP request line");
  }
  const [, method, target] = match;
  const headers = headerLines.map((line) => {
    const colon = line.indexOf(":");
    return colon > 0 ? [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] : [line, ""];
  });

  const credentials = parseBasicAuth(headerValue(headers, "proxy-authorization"));
  if (!credentials || !authenticate(credentials.user, credentials.pass)) {
    send(
      httpResponse("407 Proxy Authentication Required", {
        "Proxy-Authenticate": 'Basic realm="OpenFoxy"',
      }),
    );
    throw new HandshakeError("HTTP proxy authentication failed");
  }

  const reject = (code) => send(httpResponse((FAILURES[code] ?? DEFAULT_FAILURE).http));

  if (method === "CONNECT") {
    const authority = parseAuthority(target);
    if (!authority) {
      send(httpResponse("400 Bad Request"));
      throw new HandshakeError("malformed CONNECT target");
    }
    return {
      protocol: "http",
      ...authority,
      accept: () => send("HTTP/1.1 200 Connection Established\r\n\r\n"),
      reject,
    };
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    url = null;
  }
  if (url?.protocol !== "http:") {
    send(httpResponse("400 Bad Request"));
    throw new HandshakeError("forward proxy requests must use an absolute http:// URL");
  }

  // Rewrite to origin-form and strip proxy hop-by-hop headers so credentials never reach the
  // origin. `Connection: close` keeps one request per connection: every later request on a
  // reused connection would bypass this rewrite.
  const hopByHop = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive"]);
  const forwarded = headers.filter(([name]) => !hopByHop.has(name.toLowerCase()));
  if (!headerValue(forwarded, "host")) forwarded.unshift(["Host", url.host]);
  forwarded.push(["Connection", "close"]);
  const rewritten = [
    `${method} ${url.pathname}${url.search} HTTP/1.1`,
    ...forwarded.map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");

  return {
    protocol: "http",
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port) || 80,
    initialData: Buffer.from(rewritten, "latin1"),
    accept: () => {},
    reject,
  };
}

function headerValue(headers, name) {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
}

function parseBasicAuth(value) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(value);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

function parseAuthority(value) {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]/]+)):(\d{1,5})$/.exec(value);
  if (!match) return null;
  const host = match[1] ?? match[2];
  const port = Number(match[3]);
  if (port < 1 || port > 65535 || (match[1] && !isIPv6(host))) return null;
  return { host, port };
}

function formatIPv6(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(":");
}

function socksReply(code) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function httpResponse(status, headers = {}) {
  const lines = [`HTTP/1.1 ${status}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  return `${lines.join("\r\n")}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
}
