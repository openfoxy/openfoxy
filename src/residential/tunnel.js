import { EventEmitter } from "node:events";
import { Frame, FrameDecoder, MAX_PAYLOAD, encodeFrame } from "./protocol.js";

const LINGER_MS = 10_000;

/**
 * Multiplexes many TCP streams over one master↔provider connection, with per-stream flow
 * control: if a local socket cannot keep up, the peer is told to PAUSE that stream, and a
 * congested tunnel pauses the local sockets feeding it. Memory therefore stays bounded no
 * matter how fast either end produces data.
 *
 * Frames for streams that are not attached (HELLO, READY, CONNECT, CONNECTED, SHUTDOWN, and
 * CLOSE for pending streams) are emitted as `frame` events for the owner to handle.
 */
export class Tunnel extends EventEmitter {
  #socket;
  #decoder = new FrameDecoder();
  /** @type {Map<number, { local: import("node:net").Socket, onWrite?: (n: number) => void, peerPaused: boolean, congested: boolean }>} */
  #streams = new Map();
  #closed = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = this.#decoder.push(chunk);
      } catch (error) {
        this.destroy(error);
        return;
      }
      for (const frame of frames) this.#dispatch(frame);
    });
    socket.on("drain", () => {
      for (const stream of this.#streams.values()) {
        if (!stream.congested) continue;
        stream.congested = false;
        if (!stream.peerPaused) stream.local.resume();
      }
    });
    socket.on("error", (error) => this.emit("socketError", error));
    socket.on("close", () => this.#teardown());
  }

  get socket() {
    return this.#socket;
  }

  get closed() {
    return this.#closed;
  }

  get streamCount() {
    return this.#streams.size;
  }

  send(type, streamId = 0, payload) {
    if (this.#closed || this.#socket.destroyed) return false;
    return this.#socket.write(encodeFrame(type, streamId, payload));
  }

  /**
   * Binds a local socket to a stream id and starts relaying in both directions.
   * The local socket should be paused by the caller until this point.
   */
  attach(streamId, local, { initialData, onRead, onWrite } = {}) {
    if (this.#closed) {
      local.destroy();
      return;
    }
    const stream = { local, onWrite, peerPaused: false, congested: false };
    this.#streams.set(streamId, stream);

    const forward = (chunk) => {
      onRead?.(chunk.length);
      let writable = true;
      for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD) {
        writable = this.send(Frame.DATA, streamId, chunk.subarray(offset, offset + MAX_PAYLOAD));
      }
      if (!writable && !this.#closed) {
        stream.congested = true;
        local.pause();
      }
    };

    if (initialData?.length) forward(initialData);
    local.on("data", forward);
    local.on("drain", () => this.send(Frame.RESUME, streamId));
    local.on("error", () => {}); // `close` follows and performs the cleanup.
    local.on("close", () => {
      if (this.#streams.get(streamId) !== stream) return;
      this.#streams.delete(streamId);
      this.send(Frame.CLOSE, streamId);
    });
    if (!stream.congested) local.resume();
  }

  /** Closes a stream locally and tells the peer. */
  closeStream(streamId, code = "") {
    const stream = this.#streams.get(streamId);
    this.#streams.delete(streamId);
    stream?.local.destroy();
    this.send(Frame.CLOSE, streamId, code ? Buffer.from(code) : undefined);
  }

  destroy(error) {
    if (error) this.emit("protocolError", error);
    this.#socket.destroy();
  }

  #dispatch(frame) {
    const stream = frame.streamId === 0 ? undefined : this.#streams.get(frame.streamId);
    if (!stream) {
      if (frame.type !== Frame.DATA && frame.type !== Frame.PAUSE && frame.type !== Frame.RESUME) {
        this.emit("frame", frame);
      }
      return;
    }
    switch (frame.type) {
      case Frame.DATA:
        stream.onWrite?.(frame.payload.length);
        if (!stream.local.write(frame.payload)) this.send(Frame.PAUSE, frame.streamId);
        break;
      case Frame.CLOSE:
        this.#streams.delete(frame.streamId);
        // Flush what is already queued, then release the socket even if the peer stalls.
        stream.local.end(() => stream.local.destroy());
        setTimeout(() => stream.local.destroy(), LINGER_MS).unref();
        break;
      case Frame.PAUSE:
        stream.peerPaused = true;
        stream.local.pause();
        break;
      case Frame.RESUME:
        stream.peerPaused = false;
        if (!stream.congested) stream.local.resume();
        break;
      default:
        this.emit("frame", frame);
    }
  }

  #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { local } of this.#streams.values()) local.destroy();
    this.#streams.clear();
    this.emit("close");
  }
}
