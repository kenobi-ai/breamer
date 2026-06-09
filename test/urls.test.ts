import { expect, test } from "bun:test";
import type { Context } from "hono";
import { parseEnv } from "../src/env.ts";
import {
  buildDirectBrowserEndpoint,
  buildProxiedBrowserEndpoint,
  inferPublicOrigin,
  toWebSocketOrigin,
} from "../src/urls.ts";

const env = parseEnv({
  PAGE_TIMEOUT_MS: 1,
  CHROME_HEAP_SIZE_MB: 1,
  BROWSER_WIDTH: 1,
  BROWSER_HEIGHT: 1,
  BROWSER_DEVICE_SCALE_FACTOR: 1,
  BROWSER_LOCALE: "test",
});

test("toWebSocketOrigin converts http schemes", () => {
  expect(toWebSocketOrigin("https://example.com")).toBe("wss://example.com");
  expect(toWebSocketOrigin("http://localhost:3000")).toBe(
    "ws://localhost:3000",
  );
});

test("buildProxiedBrowserEndpoint keeps CDP on the public HTTP port", () => {
  const endpoint = buildProxiedBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "https://breamer.example.com",
    env,
  );

  expect(endpoint).toEqual({
    wsEndpoint: "wss://breamer.example.com/cdp/devtools/browser/abc",
    proxyPath: "/cdp/devtools/browser/abc",
    localPath: "/devtools/browser/abc",
  });
});

test("buildProxiedBrowserEndpoint upgrades tunneled hosts to secure websockets", () => {
  const endpoint = buildProxiedBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "https://intense-convenience-creates-decimal.trycloudflare.com",
    env,
  );

  expect(endpoint.wsEndpoint).toBe(
    "wss://intense-convenience-creates-decimal.trycloudflare.com/cdp/devtools/browser/abc",
  );
});

test("buildProxiedBrowserEndpoint can use a session-scoped public CDP path", () => {
  const endpoint = buildProxiedBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "https://breamer.example.com",
    env,
    "/sessions/session-1/cdp",
  );

  expect(endpoint).toEqual({
    wsEndpoint:
      "wss://breamer.example.com/sessions/session-1/cdp/devtools/browser/abc",
    proxyPath: "/sessions/session-1/cdp/devtools/browser/abc",
    localPath: "/devtools/browser/abc",
  });
});

test("inferPublicOrigin treats non-local forwarded hosts as HTTPS", () => {
  const context = {
    req: {
      header(name: string) {
        return {
          "x-forwarded-host":
            "intense-convenience-creates-decimal.trycloudflare.com",
          "x-forwarded-proto": "http",
        }[name];
      },
    },
  } as Context;

  expect(inferPublicOrigin(context, env)).toBe(
    "https://intense-convenience-creates-decimal.trycloudflare.com",
  );
});

test("buildDirectBrowserEndpoint preserves legacy direct browser host mode", () => {
  const endpoint = buildDirectBrowserEndpoint(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    {
      ...env,
      BROWSER_HOSTNAME: "browser.example.com",
    },
  );

  expect(endpoint).toBe("wss://browser.example.com/devtools/browser/abc");
});
