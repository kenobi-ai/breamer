import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { pipeWebSockets } from "../src/cdp-proxy.ts";

class MockSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];
  closed = [];
  terminated = false;

  send(data, options = {}) {
    this.sent.push({ data, isBinary: options.binary });
  }

  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
}

test("CDP proxy preserves text frames from client to upstream", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  upstream.readyState = WebSocket.CONNECTING;

  pipeWebSockets(client, upstream);

  client.emit(
    "message",
    Buffer.from(JSON.stringify({ id: 1, method: "Browser.getVersion" })),
    false
  );
  assert.equal(upstream.sent.length, 0);

  upstream.readyState = WebSocket.OPEN;
  upstream.emit("open");

  assert.equal(upstream.sent.length, 1);
  assert.equal(upstream.sent[0].isBinary, false);
  assert.equal(
    JSON.parse(upstream.sent[0].data.toString()).method,
    "Browser.getVersion"
  );
});

test("CDP proxy preserves text frames from upstream to client", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();

  pipeWebSockets(client, upstream);

  upstream.emit(
    "message",
    Buffer.from(JSON.stringify({ id: 1, result: { product: "Chrome" } })),
    false
  );

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].isBinary, false);
  assert.equal(JSON.parse(client.sent[0].data.toString()).result.product, "Chrome");
});

test("CDP proxy still forwards binary frames as binary", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();

  pipeWebSockets(client, upstream);
  client.emit("message", Buffer.from([1, 2, 3]), true);

  assert.equal(upstream.sent.length, 1);
  assert.equal(upstream.sent[0].isBinary, true);
});
