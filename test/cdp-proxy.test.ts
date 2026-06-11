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

const flushProxyQueue = () => new Promise((resolve) => setTimeout(resolve, 0));

const renderingDefaults = {
  acceptLanguage: "en-GB,en-US;q=0.9,en;q=0.8",
  colorGamut: "p3" as const,
  deviceMemoryGb: 8,
  deviceScaleFactor: 2,
  hardwareConcurrency: 10,
  height: 956,
  languages: ["en-GB", "en-US", "en"],
  platform: "MacIntel",
  prefersColorScheme: "light" as const,
  prefersReducedMotion: "no-preference" as const,
  timezone: "Europe/London",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  userAgentMetadata: {
    architecture: "arm",
    bitness: "64",
    brands: [
      { brand: "Chromium", version: "131" },
      { brand: "Google Chrome", version: "131" },
      { brand: "Not.A/Brand", version: "99" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: "131.0.0.0" },
      { brand: "Google Chrome", version: "131.0.0.0" },
      { brand: "Not.A/Brand", version: "99.0.0.0" },
    ],
    mobile: false,
    model: "",
    platform: "macOS",
    platformVersion: "15.0.0",
    wow64: false,
  },
  width: 1470,
};

test("CDP proxy preserves text frames from client to upstream", async () => {
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
  await flushProxyQueue();

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

test("CDP proxy still forwards binary frames as binary", async () => {
  const client = new MockSocket();
  const upstream = new MockSocket();

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream));
  client.emit("message", Buffer.from([1, 2, 3]), true);
  await flushProxyQueue();

  expect(upstream.sent).toHaveLength(1);
  expect(upstream.sent[0]?.isBinary).toBe(true);
});

test("CDP proxy exposes page session attachment before rendering defaults", async () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  const attachedEvent = {
    method: "Target.attachedToTarget",
    params: {
      sessionId: "page-session",
      targetInfo: {
        targetId: "target-id",
        type: "page",
      },
    },
  };

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream), {
    renderingDefaults,
    renderingDefaultsTimeoutMs: 25,
  });

  upstream.emit("message", Buffer.from(JSON.stringify(attachedEvent)), false);
  await flushProxyQueue();

  expect(client.sent).toHaveLength(1);
  expect(JSON.parse(client.sent[0]?.data.toString() ?? "{}")).toEqual(
    attachedEvent,
  );
  expect(upstream.sent).toHaveLength(0);
});

test("CDP proxy applies rendering defaults before first page command", async () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  const defaultEvents: string[] = [];
  const attachedEvent = {
    method: "Target.attachedToTarget",
    params: {
      sessionId: "page-session",
      targetInfo: {
        targetId: "target-id",
        type: "page",
      },
    },
  };
  const clientCommand = {
    id: 20,
    sessionId: "page-session",
    method: "Page.enable",
  };

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream), {
    renderingDefaults,
    renderingDefaultsTimeoutMs: 25,
    onRenderingDefaults: (details) => defaultEvents.push(details.status),
  });

  upstream.emit("message", Buffer.from(JSON.stringify(attachedEvent)), false);
  await flushProxyQueue();
  expect(client.sent).toHaveLength(1);
  expect(upstream.sent).toHaveLength(0);

  client.emit("message", Buffer.from(JSON.stringify(clientCommand)), false);
  await flushProxyQueue();
  expect(upstream.sent).toHaveLength(9);

  const commands = upstream.sent.map((frame) =>
    JSON.parse(frame.data.toString()),
  );
  expect(commands.map((command) => command.method)).toEqual([
    "Network.setUserAgentOverride",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Emulation.setLocaleOverride",
    "Emulation.setEmulatedMedia",
    "Emulation.setFocusEmulationEnabled",
    "Emulation.setIdleOverride",
    "Page.addScriptToEvaluateOnNewDocument",
    "Emulation.setTimezoneOverride",
  ]);
  expect(commands[0]?.sessionId).toBe("page-session");
  expect(commands[0]?.params.acceptLanguage).toBe("en-GB,en-US;q=0.9,en;q=0.8");
  expect(commands[0]?.params.userAgentMetadata.platform).toBe("macOS");
  expect(commands[1]?.params.deviceScaleFactor).toBe(2);
  expect(commands[8]?.params.timezoneId).toBe("Europe/London");

  for (const command of commands) {
    upstream.emit(
      "message",
      Buffer.from(JSON.stringify({ id: command.id, result: {} })),
      false,
    );
  }
  await flushProxyQueue();
  await flushProxyQueue();

  expect(defaultEvents).toEqual(["completed"]);
  expect(upstream.sent).toHaveLength(10);
  expect(JSON.parse(upstream.sent[9]?.data.toString() ?? "{}")).toEqual(
    clientCommand,
  );
});

test("CDP proxy settles pages before captureSnapshot", async () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  const settleEvents: string[] = [];

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream), {
    archiveSettleTimeoutMs: 25,
    onArchiveSettle: (details) => settleEvents.push(details.status),
  });

  client.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        id: 10,
        sessionId: "page-session",
        method: "Page.captureSnapshot",
      }),
    ),
    false,
  );
  await flushProxyQueue();

  expect(upstream.sent).toHaveLength(1);
  const settleCommand = JSON.parse(upstream.sent[0]?.data.toString() ?? "{}");
  expect(settleCommand.id).toBeLessThan(0);
  expect(settleCommand.sessionId).toBe("page-session");
  expect(settleCommand.method).toBe("Runtime.evaluate");
  expect(settleCommand.params.expression).toContain(
    "shouldAutoScrollBeforeCapture",
  );
  expect(settleCommand.params.expression).toContain("shadowRoot");
  expect(settleCommand.params.expression).toContain("scrollContainer");
  expect(settleCommand.params.expression).toContain("::before");
  expect(settleCommand.params.expression).toContain("mask-image");
  expect(settleCommand.params.expression).toContain("fetchPriority");
  expect(settleCommand.params.expression).toContain(
    "data-breamer-fonts-inlined",
  );
  expect(settleCommand.params.expression).toContain("@font-face");
  expect(settleCommand.params.expression).toContain(
    "normalizeParserUnsafeParagraphs",
  );
  expect(settleCommand.params.expression).toContain("paragraphBreakingTags");
  expect(settleCommand.params.expression).toContain(
    "data-breamer-original-tag",
  );

  upstream.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        id: settleCommand.id,
        result: { result: { type: "object", value: {} } },
      }),
    ),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(client.sent).toHaveLength(0);
  expect(upstream.sent).toHaveLength(2);
  expect(JSON.parse(upstream.sent[1]?.data.toString() ?? "{}")).toEqual({
    id: 10,
    sessionId: "page-session",
    method: "Page.captureSnapshot",
  });
  expect(settleEvents).toEqual(["completed"]);
});

test("CDP proxy still captures when archive settling times out", async () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  const settleEvents: string[] = [];

  pipeWebSockets(asWebSocket(client), asWebSocket(upstream), {
    archiveSettleTimeoutMs: 5,
    onArchiveSettle: (details) => settleEvents.push(details.status),
  });

  client.emit(
    "message",
    Buffer.from(JSON.stringify({ id: 11, method: "Page.captureSnapshot" })),
    false,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(upstream.sent).toHaveLength(2);
  expect(JSON.parse(upstream.sent[1]?.data.toString() ?? "{}").method).toBe(
    "Page.captureSnapshot",
  );
  expect(settleEvents).toEqual(["timeout"]);
});
