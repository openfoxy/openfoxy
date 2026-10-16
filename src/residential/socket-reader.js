/**
 * Promise-based reads over a socket for handshakes (SOCKS5, HTTP proxy headers), where a
 * protocol message may arrive split across TCP segments or coalesced with the next one.
 */
export class SocketReader {
  #socket;
  #buffer = Buffer.alloc(0);
  #pending = null;
  #done = false;
  #onData = (chunk) => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#settle();
  };
  #onEnd = () => {
    this.#done = true;
    this.#settle();
  };

  constructor(socket) {
    this.#socket = socket;
    socket.on("data", this.#onData);
    socket.on("end", this.#onEnd);
    socket.on("close", this.#onEnd);
    socket.on("error", this.#onEnd);
  }

  /** Resolves with exactly `length` bytes. */
  read(length) {
    return this.#wait((buffer) => (buffer.length >= length ? length : -1));
  }

  /** Like `read`, but leaves the bytes in the buffer. */
  peek(length) {
    return this.#wait((buffer) => (buffer.length >= length ? length : -1), false);
  }

  /** Resolves with everything up to and including `delimiter`; rejects past `maxLength` bytes. */
  readUntil(delimiter, maxLength) {
    return this.#wait((buffer) => {
      const index = buffer.indexOf(delimiter);
      if (index >= 0) return index + delimiter.length;
      if (buffer.length > maxLength) throw new Error("message too large");
      return -1;
    });
  }

  /**
   * Stops reading, leaves the socket paused, and returns bytes that arrived beyond the
   * handshake so the caller can forward them.
   */
  release() {
    this.#socket.pause();
    this.#socket.off("data", this.#onData);
    this.#socket.off("end", this.#onEnd);
    this.#socket.off("close", this.#onEnd);
    this.#socket.off("error", this.#onEnd);
    const rest = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return rest;
  }

  #wait(measure, consume = true) {
    if (this.#pending) return Promise.reject(new Error("concurrent read"));
    return new Promise((resolve, reject) => {
      this.#pending = { measure, consume, resolve, reject };
      this.#settle();
    });
  }

  #settle() {
    const pending = this.#pending;
    if (!pending) return;
    let length;
    try {
      length = pending.measure(this.#buffer);
    } catch (error) {
      this.#pending = null;
      pending.reject(error);
      return;
    }
    if (length >= 0) {
      this.#pending = null;
      const message = this.#buffer.subarray(0, length);
      if (pending.consume) this.#buffer = this.#buffer.subarray(length);
      pending.resolve(message);
    } else if (this.#done) {
      this.#pending = null;
      pending.reject(new Error("connection closed during handshake"));
    }
  }
}
