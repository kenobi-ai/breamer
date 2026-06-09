import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectBrowserEndpoint,
  buildProxiedBrowserEndpoint,
  inferPublicOrigin,
  toWebSocketOrigin
} from "../src/urls.ts";

const env = {
  HOST: "0.0.0.0",
  PORT: 3000,
  CHROME_DEBUG_PORT: 9222,
  HEADLESS: true,
  PAGE_TIMEOUT_MS: 120000,
  CHROME_HEAP_SIZE_MB: 4096,
  CDP_PROXY: true,
  CDP_PROXY_PATH: "/cdp"
};

test("toWebSocketOrigin converts http schemes", () => {
  assert.equal(toWebSocketOrigin("https://example.com"), "wss://example.com");
  assert.equal(toWebSocketOrigin("http://localhost:3000"), "ws://localhost:3000");
});

test("buildProxiedBrowserEndpoint keeps CDP on the public HTTP port", () => {
  const endpoint = buildProxiedBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "https://breamer.example.com",
    env
  );

  assert.deepEqual(endpoint, {
    wsEndpoint: "wss://breamer.example.com/cdp/devtools/browser/abc",
    proxyPath: "/cdp/devtools/browser/abc",
    localPath: "/devtools/browser/abc"
  });
});

test("buildProxiedBrowserEndpoint upgrades tunneled hosts to secure websockets", () => {
  const endpoint = buildProxiedBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "https://intense-convenience-creates-decimal.trycloudflare.com",
    env
  );

  assert.equal(
    endpoint.wsEndpoint,
    "wss://intense-convenience-creates-decimal.trycloudflare.com/cdp/devtools/browser/abc"
  );
});

test("buildProxiedBrowserEndpoint can use a session-scoped public CDP path", () => {
  const endpoint = buildProxiedBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "https://breamer.example.com",
    env,
    "/sessions/session-1/cdp"
  );

  assert.deepEqual(endpoint, {
    wsEndpoint: "wss://breamer.example.com/sessions/session-1/cdp/devtools/browser/abc",
    proxyPath: "/sessions/session-1/cdp/devtools/browser/abc",
    localPath: "/devtools/browser/abc"
  });
});

test("inferPublicOrigin treats non-local forwarded hosts as HTTPS", () => {
  const context = {
    req: {
      header(name) {
        return {
          "x-forwarded-host": "intense-convenience-creates-decimal.trycloudflare.com",
          "x-forwarded-proto": "http"
        }[name];
      }
    }
  };

  assert.equal(
    inferPublicOrigin(context, env),
    "https://intense-convenience-creates-decimal.trycloudflare.com"
  );
});

test("buildDirectBrowserEndpoint preserves legacy direct browser host mode", () => {
  const endpoint = buildDirectBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    {
      ...env,
      BROWSER_HOSTNAME: "browser.example.com"
    }
  );

  assert.equal(endpoint, "wss://browser.example.com/devtools/browser/abc");
});
