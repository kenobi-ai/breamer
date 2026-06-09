import { expect, test } from "bun:test";
import { createApp, parseEnv } from "../src/server.ts";

const fakeBrowserEndpoint =
  "ws://127.0.0.1:9222/devtools/browser/96a96c29-36ad-47da-be46-35249f44dc66";

const testEnv = (overrides: Parameters<typeof parseEnv>[0] = {}) =>
  parseEnv({
    PAGE_TIMEOUT_MS: 1,
    CHROME_HEAP_SIZE_MB: 1,
    BROWSER_WIDTH: 1,
    BROWSER_HEIGHT: 1,
    BROWSER_DEVICE_SCALE_FACTOR: 1,
    BROWSER_LOCALE: "test",
    ...overrides,
  });

test("root endpoint is not exposed", async () => {
  const app = createApp(testEnv());

  const response = await app.request("/");
  expect(response.status).toBe(404);
  expect((await response.json()).error).toBe("not_found");
});

test("health endpoint requires the configured access token", async () => {
  const app = createApp(testEnv({ ACCESS_TOKEN: "secret" }));

  const response = await app.request("/health");
  expect(response.status).toBe(401);
  expect((await response.json()).error).toBe("unauthorized");
});

test("health endpoint accepts bearer token", async () => {
  const app = createApp(testEnv({ ACCESS_TOKEN: "secret" }));

  const response = await app.request("/health", {
    headers: {
      authorization: "Bearer secret",
    },
  });
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.status).toBe("starting");
  expect(body.network.accessEnabled).toBe(true);
});

test("/cdp requires the configured access token", async () => {
  const app = createApp(testEnv({ ACCESS_TOKEN: "secret" }), {
    getBrowserEndpoint: () => fakeBrowserEndpoint,
  });

  const response = await app.request("/cdp");
  expect(response.status).toBe(401);
  expect((await response.json()).error).toBe("unauthorized");
});

test("/cdp returns session-scoped websocket and shutdown URLs", async () => {
  const app = createApp(testEnv({ ACCESS_TOKEN: "secret" }), {
    getBrowserEndpoint: () => fakeBrowserEndpoint,
  });

  const response = await app.request("/cdp", {
    headers: {
      authorization: "Bearer secret",
      "x-forwarded-host": "breamer.example.com",
      "x-forwarded-proto": "https",
      "x-breamer-session-id": "00382bb3-25dd-433c-bce4-495dd0438ea2",
      "x-breamer-public-cdp-path":
        "/sessions/00382bb3-25dd-433c-bce4-495dd0438ea2/cdp",
      "x-breamer-public-shutdown-path":
        "/sessions/00382bb3-25dd-433c-bce4-495dd0438ea2/shutdown",
    },
  });
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.mode).toBe("proxy");
  expect(body.sessionId).toBe("00382bb3-25dd-433c-bce4-495dd0438ea2");
  expect(body.wsEndpoint).toBe(
    "wss://breamer.example.com/sessions/00382bb3-25dd-433c-bce4-495dd0438ea2/cdp/devtools/browser/96a96c29-36ad-47da-be46-35249f44dc66",
  );
  expect(body.shutdownUrl).toBe(
    "https://breamer.example.com/sessions/00382bb3-25dd-433c-bce4-495dd0438ea2/shutdown",
  );
});

test("shutdown endpoint requests shutdown without a token", async () => {
  let shutdownRequested = false;
  const app = createApp(testEnv(), {
    requestShutdown: () => {
      shutdownRequested = true;
    },
  });

  const response = await app.request("/shutdown", { method: "POST" });
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.status).toBe("shutting_down");

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(shutdownRequested).toBe(true);
});
