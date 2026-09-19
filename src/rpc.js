// rpc.js - minimal JSON-RPC 2.0 over stdio with LSP Content-Length framing.
// Shared by the VS Code client (node) and the Bend language server (bun).
// No dependencies, no vscode import. Protocol plumbing only: every answer
// about the Bend language itself comes from the real checker (bend.ts).

"use strict";

class RpcPeer {
  constructor(readable, writable) {
    this.readable = readable;
    this.writable = writable;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.requestHandler = null;  // async (method, params) => result
    this.notificationHandler = null; // (method, params) => void
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.readable.on("data", (chunk) => this._pump(chunk));
    this.readable.on("end", () => { this.closed = true; });
    this.readable.on("error", () => { this.closed = true; });
  }

  _pump(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buffer.slice(0, sep).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buffer = Buffer.alloc(0); return; }
      const len = parseInt(m[1], 10);
      if (this.buffer.length < sep + 4 + len) return; // wait for the body
      const body = this.buffer.slice(sep + 4, sep + 4 + len).toString("utf8");
      this.buffer = this.buffer.slice(sep + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch (e) { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.method !== undefined && (msg.id === undefined || msg.id === null)) {
      if (this.notificationHandler) {
        try { this.notificationHandler(msg.method, msg.params || {}); }
        catch (e) { /* notifications must not kill the peer */ }
      }
      return;
    }
    if (msg.method !== undefined) { // a request
      const respond = (err, result) => this._write({
        jsonrpc: "2.0", id: msg.id,
        ...(err ? { error: err } : { result: result === undefined ? null : result }),
      });
      if (!this.requestHandler) return respond({ code: -32601, message: "MethodNotFound" });
      Promise.resolve()
        .then(() => this.requestHandler(msg.method, msg.params || {}))
        .then((r) => respond(null, r), (e) =>
          respond({ code: -32603, message: String((e && e.message) || e) }));
      return;
    }
    if (msg.id !== undefined && msg.id !== null) { // a response to us
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    }
  }

  _write(obj) {
    if (this.closed) return;
    try {
      const body = JSON.stringify(obj);
      this.writable.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch (e) { /* broken pipe: drop */ }
  }

  notify(method, params) { this._write({ jsonrpc: "2.0", method, params: params || {} }); }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: "2.0", id, method, params: params || {} });
    });
  }
}

module.exports = { RpcPeer };
