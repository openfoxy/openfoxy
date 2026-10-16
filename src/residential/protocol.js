/**
 * Wire protocol between the master gateway and residential providers.
 *
 * Every message is a frame: `type (u8) | stream id (u32 BE) | payload length (u32 BE) | payload`.
 * Stream id 0 is the control channel. Payloads are raw bytes, so relayed traffic carries no
 * encoding overhead.
 */
export const PROTOCOL_VERSION = 2;
export const HEADER_SIZE = 9;
export const MAX_PAYLOAD = 256 * 1024;

export const Frame = Object.freeze({
  HELLO: 1, // provider → master: [version u8][token utf8]
  READY: 2, // master → provider: authentication accepted
  CONNECT: 3, // master → provider: [port u16 BE][host utf8]
  CONNECTED: 4, // provider → master: target connection established
  DATA: 5, // both: stream bytes
  CLOSE: 6, // both: stream finished; optional payload is an error code such as ECONNREFUSED
  PAUSE: 7, // both: receiver is congested, stop sending on this stream
  RESUME: 8, // both: receiver drained, continue
  SHUTDOWN: 9, // provider → master: graceful disconnect, do not penalise
});

const KNOWN_TYPES = new Set(Object.values(Frame));

export class ProtocolError extends Error {
  name = "ProtocolError";
}

export function encodeFrame(type, streamId = 0, payload = Buffer.alloc(0)) {
  if (payload.length > MAX_PAYLOAD) throw new ProtocolError("frame payload too large");
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId, 1);
  header.writeUInt32BE(payload.length, 5);
  return payload.length ? Buffer.concat([header, payload]) : header;
}

/** Incremental decoder: feed socket chunks, receive whole frames. */
export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  /** @returns {{ type: number, streamId: number, payload: Buffer }[]} */
  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const frames = [];
    while (this.#buffer.length >= HEADER_SIZE) {
      const type = this.#buffer.readUInt8(0);
      const length = this.#buffer.readUInt32BE(5);
      if (!KNOWN_TYPES.has(type)) throw new ProtocolError(`unknown frame type ${type}`);
      if (length > MAX_PAYLOAD)
        throw new ProtocolError(`frame payload of ${length} bytes is too large`);
      if (this.#buffer.length < HEADER_SIZE + length) break;
      frames.push({
        type,
        streamId: this.#buffer.readUInt32BE(1),
        payload: this.#buffer.subarray(HEADER_SIZE, HEADER_SIZE + length),
      });
      this.#buffer = this.#buffer.subarray(HEADER_SIZE + length);
    }
    return frames;
  }
}

export function encodeHello(token) {
  return Buffer.concat([Buffer.from([PROTOCOL_VERSION]), Buffer.from(token, "utf8")]);
}

export function decodeHello(payload) {
  if (payload.length < 2) throw new ProtocolError("malformed HELLO");
  return { version: payload.readUInt8(0), token: payload.subarray(1).toString("utf8") };
}

export function encodeTarget(host, port) {
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(port, 0);
  return Buffer.concat([header, Buffer.from(host, "utf8")]);
}

export function decodeTarget(payload) {
  if (payload.length < 3 || payload.length > 2 + 255) throw new ProtocolError("malformed CONNECT");
  return { port: payload.readUInt16BE(0), host: payload.subarray(2).toString("utf8") };
}
