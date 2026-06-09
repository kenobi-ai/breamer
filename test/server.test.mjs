import assert from "node:assert/strict";
import test from "node:test";
import { createApp, parseEnv } from "../src/server.ts";

const fakeBrowserEndpoint =
  "ws://127.0.0.1:9222/devtools/browser/96a96c29-36ad-47da-be46-35249f44dc66";

test("root endpoint is not exposed", async () => {
  const app = createApp(parseEnv());

  const response = await app.request("/");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "not_found");
});

test("health endpoint requires the configured access token", async () => {
  const app = createApp(parseEnv({ ACCESS_TOKEN: "secret" }));

  const response = await app.request("/health");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});

test("health endpoint accepts bearer token", async () => {
  const app = createApp(parseEnv({ ACCESS_TOKEN: "secret" }));

  const response = await app.request("/health", {
    headers: {
      authorization: "Bearer secret"
    }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "starting");
  assert.equal(body.network.accessEnabled, true);
});

test("/cdp requires the configured access token", async () => {
  const app = createApp(parseEnv({ ACCESS_TOKEN: "secret" }), {
    getBrowserEndpoint: () => fakeBrowserEndpoint
  });

  const response = await app.request("/cdp");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});

test("/cdp returns session-scoped websocket and shutdown URLs", async () => {
  const app = createApp(parseEnv({ ACCESS_TOKEN: "secret" }), {
    getBrowserEndpoint: () => fakeBrowserEndpoint
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
        "/sessions/00382bb3-25dd-433c-bce4-495dd0438ea2/shutdown"
    }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.mode, "proxy");
  assert.equal(body.sessionId, "00382bb3-25dd-433c-bce4-495dd0438ea2");
  assert.equal(
    body.wsEndpoint,
    "wss://breamer.example.com/sessions/00382bb3-25dd-433c-bce4-495dd0438ea2/cdp/devtools/browser/96a96c29-36ad-47da-be46-35249f44dc66"
  );
  assert.equal(
    body.shutdownUrl,
    "https://breamer.example.com/sessions/00382bb3-25dd-433c-bce4-495dd0438ea2/shutdown"
  );
});

test("shutdown endpoint requests shutdown without a token", async () => {
  let shutdownRequested = false;
  const app = createApp(parseEnv(), {
    requestShutdown: () => {
      shutdownRequested = true;
    }
  });

  const response = await app.request("/shutdown", { method: "POST" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "shutting_down");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownRequested, true);
});
