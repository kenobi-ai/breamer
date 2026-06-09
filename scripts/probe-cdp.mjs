#!/usr/bin/env node

import puppeteer from "puppeteer";

const DEFAULT_TIMEOUT_MS = 15_000;

const usage = () => {
  console.log(`Usage:
  bun scripts/probe-cdp.mjs <root-url> [--shutdown] [--token <access-token>] [--timeout <ms>]

Examples:
  BREAMER_ACCESS_TOKEN=dev-secret bun scripts/probe-cdp.mjs http://localhost:8787
  BREAMER_ACCESS_TOKEN="$BREAMER_ACCESS_TOKEN" bun scripts/probe-cdp.mjs "$BREAMER_ROOT_URL"
  bun scripts/probe-cdp.mjs https://your-worker.workers.dev --shutdown --token "$BREAMER_ACCESS_TOKEN"
`);
};

const readArgs = () => {
  const args = process.argv.slice(2);
  let rootUrl = process.env.BREAMER_ROOT_URL;
  let shutdown = false;
  let token = process.env.BREAMER_ACCESS_TOKEN ?? process.env.BREAMER_TOKEN;
  let timeoutMs = Number(process.env.BREAMER_PROBE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    if (arg === "--shutdown") {
      shutdown = true;
      continue;
    }

    if (arg === "--token") {
      token = args[++i];
      continue;
    }

    if (arg === "--timeout") {
      timeoutMs = Number(args[++i]);
      continue;
    }

    if (!rootUrl) {
      rootUrl = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!rootUrl) {
    throw new Error("Pass a root URL or set BREAMER_ROOT_URL.");
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Timeout must be a positive number.");
  }

  return {
    rootUrl: new URL(rootUrl),
    shutdown,
    token,
    timeoutMs
  };
};

const step = (message) => {
  console.log(`probe: ${message}`);
};

const withTimeout = async (promise, timeoutMs, label, onTimeout) => {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const rootHref = (rootUrl) => {
  rootUrl.pathname = rootUrl.pathname.replace(/\/+$/, "");
  rootUrl.search = "";
  rootUrl.hash = "";
  return rootUrl.toString().replace(/\/$/, "");
};

const fetchJson = async (url, timeoutMs, token) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = token
      ? {
          authorization: `Bearer ${token}`
        }
      : undefined;
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
};

const fetchCdpEndpoint = async (rootUrl, timeoutMs, token) => {
  const endpointUrl = `${rootHref(new URL(rootUrl))}/cdp`;
  step(`fetching ${endpointUrl}`);

  const body = await fetchJson(endpointUrl, timeoutMs, token);
  if (!body.wsEndpoint) {
    throw new Error(`Missing wsEndpoint in /cdp response: ${JSON.stringify(body)}`);
  }
  if (!body.shutdownUrl) {
    throw new Error(`Missing shutdownUrl in /cdp response: ${JSON.stringify(body)}`);
  }

  const wsEndpoint = new URL(body.wsEndpoint);
  const expectedProtocol = rootUrl.protocol === "https:" ? "wss:" : "ws:";
  if (wsEndpoint.protocol !== expectedProtocol) {
    throw new Error(
      `/cdp returned ${wsEndpoint.protocol}, expected ${expectedProtocol} for ${rootUrl.origin}`
    );
  }

  step(`got ${wsEndpoint.href}`);
  return {
    wsEndpoint: wsEndpoint.href,
    shutdownUrl: body.shutdownUrl
  };
};

const probeRawCdp = async (wsEndpoint, timeoutMs) => {
  step("opening raw CDP WebSocket");

  const WebSocketCtor =
    globalThis.WebSocket ?? (await import("ws")).WebSocket;
  let socket;
  const result = await withTimeout(
    new Promise((resolve, reject) => {
      let gotMessage = false;
      socket = new WebSocketCtor(wsEndpoint);

      const onOpen = () => {
        step("raw WebSocket opened");
        socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      };

      const onMessage = (eventOrData) => {
        gotMessage = true;
        const data =
          typeof eventOrData === "object" &&
          eventOrData !== null &&
          "data" in eventOrData
            ? eventOrData.data
            : eventOrData;
        resolve(JSON.parse(data.toString()));
      };

      const onClose = (eventOrCode, maybeReason) => {
        if (!gotMessage) {
          const code =
            typeof eventOrCode === "object" ? eventOrCode.code : eventOrCode;
          const reason =
            typeof eventOrCode === "object"
              ? eventOrCode.reason
              : maybeReason?.toString();
          reject(
            new Error(
              `raw WebSocket closed before CDP response: ${code} ${reason ?? ""}`
            )
          );
        }
      };

      if ("addEventListener" in socket) {
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("message", onMessage, { once: true });
        socket.addEventListener("close", onClose, { once: true });
        socket.addEventListener("error", reject, { once: true });
      } else {
        socket.once("open", onOpen);
        socket.once("message", onMessage);
        socket.once("close", onClose);
        socket.once("error", reject);
      }
    }),
    timeoutMs,
    "raw CDP probe",
    () => {
      socket?.terminate?.();
      socket?.close?.();
    }
  );

  socket?.close(1000, "probe complete");

  if (!result.result?.product) {
    throw new Error(`Unexpected CDP response: ${JSON.stringify(result)}`);
  }

  step(`raw CDP responded with ${result.result.product}`);
};

const probePuppeteer = async (wsEndpoint, timeoutMs) => {
  step("connecting Puppeteer");

  let browser;
  try {
    browser = await withTimeout(
      puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
        protocolTimeout: timeoutMs
      }),
      timeoutMs,
      "puppeteer.connect"
    );

    step(`Puppeteer connected to ${await browser.version()}`);

    const page = await withTimeout(
      browser.newPage(),
      timeoutMs,
      "browser.newPage"
    );

    await withTimeout(
      page.goto("data:text/html,<title>breamer-probe</title><h1>ok</h1>", {
        waitUntil: "load",
        timeout: timeoutMs
      }),
      timeoutMs,
      "page.goto"
    );

    const title = await page.title();
    await page.close();

    if (title !== "breamer-probe") {
      throw new Error(`Unexpected page title: ${title}`);
    }

    step("Puppeteer page round-trip passed");
  } finally {
    browser?.disconnect();
  }
};

const shutdownBreamer = async (shutdownUrl, timeoutMs) => {
  step(`shutting down ${shutdownUrl}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(shutdownUrl, {
      method: "POST",
      signal: controller.signal
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }

    step(`shutdown response ${text}`);
  } finally {
    clearTimeout(timer);
  }
};

const main = async () => {
  const { rootUrl, shutdown, token, timeoutMs } = readArgs();
  const { wsEndpoint, shutdownUrl } = await fetchCdpEndpoint(
    rootUrl,
    timeoutMs,
    token
  );

  await probeRawCdp(wsEndpoint, timeoutMs);
  await probePuppeteer(wsEndpoint, timeoutMs);

  if (shutdown) {
    await shutdownBreamer(shutdownUrl, timeoutMs);
  }

  step("passed");
};

main().catch((error) => {
  if (process.env.BREAMER_PROBE_DEBUG) {
    console.error("probe: failed:");
    console.error(error);
    process.exit(1);
  }

  const details = error instanceof Error ? error.message : String(error);
  console.error(`probe: failed: ${details}`);
  process.exit(1);
});
