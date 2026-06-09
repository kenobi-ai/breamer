import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { pipeWebSockets } from "../src/cdp-proxy.ts";

interface SentFrame {
  data: WebSocket.RawData;
  isBinary: boolean | undefined;
}

class MockSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: SentFrame[] = [];
  closed: Array<{ code?: number; reason?: Buffer }> = [];
  terminated = false;

  send(data: WebSocket.RawData, options: { binary?: boolean } = {}) {
    this.sent.push({ data, isBinary: options.binary });
  }

  close(code?: number, reason?: Buffer) {
    this.closed.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
}

const asWebSocket = (socket: MockSocket): WebSocket =>
  socket as unknown as WebSocket;

test("CDP proxy preserves text frames from client to upstream", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  upstream.readyState = WebSocket.CONNECTING;

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream));

  client.emit(
    "message",
    Buffer.from(JSON.stringify({ id: 1, method: "Browser.getVersion" })),
    false,
  );
  expect(upstream.sent).toHaveLength(0);

  upstream.readyState = WebSocket.OPEN;
  upstream.emit("open");

  expect(upstream.sent).toHaveLength(1);
  expect(upstream.sent[0]?.isBinary).toBe(false);
  expect(JSON.parse(upstream.sent[0]?.data.toString() ?? "{}").method).toBe(
    "Browser.getVersion",
  );
});

test("CDP proxy preserves text frames from upstream to client", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream));

  upstream.emit(
    "message",
    Buffer.from(JSON.stringify({ id: 1, result: { product: "Chrome" } })),
    false,
  );

  expect(client.sent).toHaveLength(1);
  expect(client.sent[0]?.isBinary).toBe(false);
  expect(
    JSON.parse(client.sent[0]?.data.toString() ?? "{}").result.product,
  ).toBe("Chrome");
});

test("CDP proxy still forwards binary frames as binary", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream));
  client.emit("message", Buffer.from([1, 2, 3]), true);

  expect(upstream.sent).toHaveLength(1);
  expect(upstream.sent[0]?.isBinary).toBe(true);
});
