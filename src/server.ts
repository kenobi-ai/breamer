import { serve } from "@hono/node-server";
// pokayoke-ignore-file: structure/max-file-lines -- Worker-facing browser orchestration is intentionally kept together while the service surface is still compact.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { pipeWebSockets } from "./cdp-proxy.js";
import { parseEnv, type Env } from "./env.js";
import { logger } from "./logger.js";
import {
  buildDirectBrowserEndpoint,
  buildProxiedBrowserEndpoint,
  inferPublicOrigin
} from "./urls.js";

type AppVariables = {
  requestId: string;
  sessionId?: string;
};

let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

const pageCleanupTimers = new WeakMap<Page, NodeJS.Timeout>();

const metrics = {
  startedAt: new Date(),
  pagesCreated: 0,
  pagesNavigated: 0,
  pagesClosed: 0,
  pagesAutoCleanedUp: 0,
  consoleErrors: 0,
  pageErrors: 0,
  cdpProxyConnections: 0,
  cdpProxyErrors: 0
};

const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(" ");
};

const schedulePageCleanup = (page: Page, timeoutMs: number): void => {
  const existingTimer = pageCleanupTimers.get(page);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(async () => {
    try {
      if (!page.isClosed()) {
        const url = page.url();
        logger.page("auto-closing", `${url} after ${timeoutMs / 1000}s idle`);
        metrics.pagesAutoCleanedUp++;
        await page.close();
      }
    } catch (error) {
      logger.page("auto-close failed", { error: describeError(error) });
    }
  }, timeoutMs);

  pageCleanupTimers.set(page, timer);
};

const cancelPageCleanup = (page: Page): void => {
  const timer = pageCleanupTimers.get(page);
  if (timer) {
    clearTimeout(timer);
    pageCleanupTimers.delete(page);
  }
};

const resolveExecutablePath = (env: Env): string | undefined => {
  return env.CHROME_EXECUTABLE_PATH ?? env.PUPPETEER_EXECUTABLE_PATH;
};

const describeError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message?: unknown }).message);
  }

  return String(err);
};

const requestLogContext = (c: Context): Record<string, unknown> => ({
  requestId: c.get("requestId" as never),
  sessionId: c.req.header("x-breamer-session-id"),
  path: c.req.path
});

const headerValue = (
  value: string | string[] | undefined
): string | undefined => (Array.isArray(value) ? value[0] : value);

const launchBrowser = async (env: Env): Promise<Browser> => {
  const executablePath = resolveExecutablePath(env);
  logger.browser("launching", {
    headless: env.HEADLESS,
    executablePath: executablePath ?? "(puppeteer default)",
    debugPort: env.CHROME_DEBUG_PORT,
    viewport: `${env.BROWSER_WIDTH}x${env.BROWSER_HEIGHT}`,
    deviceScaleFactor: env.BROWSER_DEVICE_SCALE_FACTOR,
    locale: env.BROWSER_LOCALE,
    heapMb: env.CHROME_HEAP_SIZE_MB,
    userAgentOverride: Boolean(env.BROWSER_USER_AGENT)
  });

  const launchedBrowser = await puppeteer.launch({
    executablePath,
    headless: env.HEADLESS,
    args: [
      `--remote-debugging-port=${env.CHROME_DEBUG_PORT}`,
      "--remote-debugging-address=0.0.0.0",
      `--window-size=${env.BROWSER_WIDTH},${env.BROWSER_HEIGHT}`,
      `--force-device-scale-factor=${env.BROWSER_DEVICE_SCALE_FACTOR}`,
      `--lang=${env.BROWSER_LOCALE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-popup-blocking",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      `--js-flags=--max-old-space-size=${env.CHROME_HEAP_SIZE_MB}`,
      "--disable-features=TranslateUI",
      "--disable-breakpad",
      "--disable-component-update",
      ...(env.BROWSER_USER_AGENT
        ? [`--user-agent=${env.BROWSER_USER_AGENT}`]
        : [])
    ]
  });

  browser = launchedBrowser;

  launchedBrowser.on("disconnected", () => {
    logger.browser("disconnected", {
      pagesCreated: metrics.pagesCreated,
      pagesClosed: metrics.pagesClosed,
      cdpProxyConnections: metrics.cdpProxyConnections
    });
    if (browser === launchedBrowser) {
      browser = null;
    }
  });

  launchedBrowser.on("targetcreated", async (target) => {
    const type = target.type();
    const url = target.url();
    logger.target("created", type, url || "(blank)");

    if (type !== "page") {
      return;
    }

    metrics.pagesCreated++;

    try {
      const page = await target.page();
      if (!page) {
        logger.target("page unavailable", type, url || "(blank)");
        return;
      }

      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          metrics.pagesNavigated++;
          logger.page("navigated", frame.url());
          schedulePageCleanup(page, env.PAGE_TIMEOUT_MS);
        }
      });

      page.on("load", () => {
        logger.page("loaded", page.url());
        schedulePageCleanup(page, env.PAGE_TIMEOUT_MS);
      });

      page.on("console", (message) => {
        if (message.type() === "error") {
          metrics.consoleErrors++;
          logger.cdp("console.error", message.text().slice(0, 150));
        }
      });

      page.on("pageerror", (err) => {
        metrics.pageErrors++;
        const message = err instanceof Error ? err.message : String(err);
        logger.cdp("pageerror", message.slice(0, 150));
      });

      page.once("close", () => {
        cancelPageCleanup(page);
        metrics.pagesClosed++;
        logger.page("closed", page.url());
      });

      schedulePageCleanup(page, env.PAGE_TIMEOUT_MS);
    } catch (error) {
      logger.target("listener attach failed", type, describeError(error));
    }
  });

  launchedBrowser.on("targetdestroyed", (target) => {
    logger.target("destroyed", target.type(), target.url() || "(blank)");
  });

  logger.success("Browser ready", {
    wsEndpoint: launchedBrowser.wsEndpoint()
  });

  return launchedBrowser;
};

const ensureBrowser = async (env: Env): Promise<Browser> => {
  if (browser?.connected) {
    return browser;
  }

  browserLaunchPromise ??= launchBrowser(env).finally(() => {
    browserLaunchPromise = null;
  });

  return browserLaunchPromise;
};

const installCdpProxy = (server: Server, env: Env): void => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket: Duplex, head) => {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`
    );
    const requestId = headerValue(request.headers["x-breamer-request-id"]);
    const sessionId = headerValue(request.headers["x-breamer-session-id"]);

    const prefix = `${env.CDP_PROXY_PATH}/`;
    if (!requestUrl.pathname.startsWith(prefix)) {
      logger.cdp("proxy rejected", {
        requestId,
        sessionId,
        path: requestUrl.pathname,
        expectedPrefix: prefix
      });
      socket.destroy();
      return;
    }

    void (async () => {
      const currentBrowser = await ensureBrowser(env);
      const browserEndpoint = new URL(currentBrowser.wsEndpoint());
      const targetPath =
        requestUrl.pathname.slice(env.CDP_PROXY_PATH.length) +
        requestUrl.search;
      const targetUrl = `${browserEndpoint.protocol}//${browserEndpoint.host}${targetPath}`;

      wss.handleUpgrade(request, socket, head, (client) => {
        metrics.cdpProxyConnections++;
        logger.cdp("proxy connect", {
          requestId,
          sessionId,
          path: requestUrl.pathname,
          targetUrl
        });
        const upstream = new WebSocket(targetUrl);
        upstream.once("open", () => {
          logger.cdp("upstream open", { requestId, sessionId, targetUrl });
        });
        client.once("close", (code, reason) => {
          logger.cdp("client close", {
            requestId,
            sessionId,
            code,
            reason: reason.toString()
          });
        });
        upstream.once("close", (code, reason) => {
          logger.cdp("upstream close", {
            requestId,
            sessionId,
            code,
            reason: reason.toString()
          });
        });
        pipeWebSockets(client, upstream, {
          onUpstreamError: (err) => {
            metrics.cdpProxyErrors++;
            logger.error(
              "CDP upstream error",
              `${targetUrl} ${describeError(err)}`
            );
          }
        });
      });
    })().catch((err) => {
      metrics.cdpProxyErrors++;
      logger.error("CDP proxy upgrade failed", err);
      socket.destroy();
    });
  });
};

export interface CreateAppOptions {
  requestShutdown?: () => void;
  getBrowserEndpoint?: () => Promise<string> | string;
}

const readRequestToken = (
  c: Context,
  headerName: string,
  queryName = "token"
): string | undefined => {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  return (
    c.req.header(headerName) ??
    c.req.header("x-breamer-token") ??
    c.req.query(queryName) ??
    (queryName === "token" ? undefined : c.req.query("token"))
  );
};

const timingSafeEqual = (left: string, right: string): boolean => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index++) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
};

const authenticateAccess = (c: Context, env: Env): Response | undefined => {
  if (!env.ACCESS_TOKEN) {
    return undefined;
  }

  const token = readRequestToken(c, "x-breamer-access-token", "access_token");
  if (!token || !timingSafeEqual(token, env.ACCESS_TOKEN)) {
    logger.warn("access denied", {
      ...requestLogContext(c),
      tokenProvided: Boolean(token)
    });
    return c.json({ error: "unauthorized" }, 401);
  }
};

const readPublicPath = (
  c: Context,
  headerName: string,
  fallbackPath: string
): string => {
  const value = c.req.header(headerName) ?? fallbackPath;
  return value.startsWith("/") ? value : `/${value}`;
};

export const createApp = (env: Env, options: CreateAppOptions = {}) => {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", cors());

  app.use("*", async (c, next) => {
    const start = performance.now();
    const requestId = c.req.header("x-breamer-request-id") ?? crypto.randomUUID();
    const sessionId = c.req.header("x-breamer-session-id");

    c.set("requestId", requestId);
    if (sessionId) {
      c.set("sessionId", sessionId);
    }

    await next();
    logger.request(
      c.req.method,
      c.req.path,
      c.res.status,
      performance.now() - start,
      {
        requestId,
        sessionId,
        userAgent: c.req.header("user-agent")
      }
    );
  });

  app.all("/", (c) => {
    return c.json({ error: "not_found" }, 404);
  });

  app.get("/health", async (c) => {
    const authResponse = authenticateAccess(c, env);
    if (authResponse) {
      return authResponse;
    }

    const isConnected = browser?.connected ?? false;
    const pages = browser ? await browser.pages() : [];
    const uptimeMs = Date.now() - metrics.startedAt.getTime();

    logger.info("health checked", {
      ...requestLogContext(c),
      connected: isConnected,
      openPages: pages.length,
      uptimeMs
    });

    return c.json({
      status: isConnected ? "healthy" : "starting",
      browser: {
        connected: isConnected,
        debugPort: env.CHROME_DEBUG_PORT,
        openPages: pages.length,
        pageTimeoutMs: env.PAGE_TIMEOUT_MS
      },
      metrics: {
        uptimeMs,
        uptimeHuman: formatUptime(uptimeMs),
        pagesCreated: metrics.pagesCreated,
        pagesNavigated: metrics.pagesNavigated,
        pagesClosed: metrics.pagesClosed,
        pagesAutoCleanedUp: metrics.pagesAutoCleanedUp,
        consoleErrors: metrics.consoleErrors,
        pageErrors: metrics.pageErrors,
        cdpProxyConnections: metrics.cdpProxyConnections,
        cdpProxyErrors: metrics.cdpProxyErrors
      },
      network: {
        host: env.HOST,
        port: env.PORT,
        cdpProxy: env.CDP_PROXY,
        cdpProxyPath: env.CDP_PROXY_PATH,
        publicOrigin: env.PUBLIC_ORIGIN ?? null,
        browserHost: env.BROWSER_HOSTNAME ?? null,
        shutdownPath: env.SHUTDOWN_PATH,
        shutdownMode: "session-route",
        accessEnabled: Boolean(env.ACCESS_TOKEN)
      }
    });
  });

  app.get("/ready", async (c) => {
    const authResponse = authenticateAccess(c, env);
    if (authResponse) {
      return authResponse;
    }

    try {
      await ensureBrowser(env);
      logger.info("ready checked", {
        ...requestLogContext(c),
        connected: browser?.connected ?? false
      });
      return c.json({ status: "ready" });
    } catch (err) {
      logger.error("Readiness check failed", err);
      return c.json({ status: "not_ready" }, 503);
    }
  });

  app.all("/cdp", async (c) => {
    const authResponse = authenticateAccess(c, env);
    if (authResponse) {
      return authResponse;
    }

    try {
      const localEndpoint = options.getBrowserEndpoint
        ? await options.getBrowserEndpoint()
        : (await ensureBrowser(env)).wsEndpoint();
      const sessionId = c.req.header("x-breamer-session-id");
      const publicCdpPath = readPublicPath(
        c,
        "x-breamer-public-cdp-path",
        env.CDP_PROXY_PATH
      );
      const publicShutdownPath = readPublicPath(
        c,
        "x-breamer-public-shutdown-path",
        env.SHUTDOWN_PATH
      );
      const publicOrigin = inferPublicOrigin(c, env);
      const shutdownUrl = new URL(publicShutdownPath, publicOrigin);

      if (!env.CDP_PROXY && env.BROWSER_HOSTNAME) {
        const wsEndpoint = buildDirectBrowserEndpoint(localEndpoint, env);
        logger.cdp("endpoint issued", {
          ...requestLogContext(c),
          mode: "direct",
          wsEndpoint,
          shutdownUrl: shutdownUrl.toString()
        });
        return c.json({
          wsEndpoint,
          shutdownUrl: shutdownUrl.toString(),
          ...(sessionId ? { sessionId } : {}),
          mode: "direct",
          path: new URL(wsEndpoint).pathname
        });
      }

      const endpoint = buildProxiedBrowserEndpoint(
        localEndpoint,
        publicOrigin,
        env,
        publicCdpPath
      );

      logger.cdp("endpoint issued", {
        ...requestLogContext(c),
        mode: "proxy",
        publicOrigin,
        wsEndpoint: endpoint.wsEndpoint,
        shutdownUrl: shutdownUrl.toString(),
        proxyPath: endpoint.proxyPath,
        localPath: endpoint.localPath
      });

      return c.json({
        wsEndpoint: endpoint.wsEndpoint,
        shutdownUrl: shutdownUrl.toString(),
        ...(sessionId ? { sessionId } : {}),
        mode: "proxy",
        path: endpoint.proxyPath,
        localPath: endpoint.localPath
      });
    } catch (err) {
      logger.error("Failed to get CDP endpoint", err);
      return c.json({ error: "Failed to get browser endpoint" }, 500);
    }
  });

  app.all(env.SHUTDOWN_PATH, async (c) => {
    logger.warn("shutdown requested", requestLogContext(c));

    setTimeout(() => {
      options.requestShutdown?.();
    }, 25);

    return c.json({ status: "shutting_down" });
  });

  return app;
};

export interface StartServerOptions {
  host?: string;
  port?: number;
  chromeDebugPort?: number;
  browserHostname?: string;
  tunnelHostname?: string;
  headless?: boolean;
  pageTimeoutMs?: number;
  chromeHeapSizeMb?: number;
  browserWidth?: number;
  browserHeight?: number;
  browserDeviceScaleFactor?: number;
  browserLocale?: string;
  browserUserAgent?: string;
  chromeExecutablePath?: string;
  publicOrigin?: string;
  cdpProxy?: boolean;
  cdpProxyPath?: string;
  accessToken?: string;
  shutdownPath?: string;
}

export const startServer = async (options: StartServerOptions = {}) => {
  const env = parseEnv({
    HOST: options.host,
    PORT: options.port,
    CHROME_DEBUG_PORT: options.chromeDebugPort,
    BROWSER_HOSTNAME: options.browserHostname,
    TUNNEL_HOSTNAME: options.tunnelHostname,
    HEADLESS: options.headless,
    PAGE_TIMEOUT_MS: options.pageTimeoutMs,
    CHROME_HEAP_SIZE_MB: options.chromeHeapSizeMb,
    BROWSER_WIDTH: options.browserWidth,
    BROWSER_HEIGHT: options.browserHeight,
    BROWSER_DEVICE_SCALE_FACTOR: options.browserDeviceScaleFactor,
    BROWSER_LOCALE: options.browserLocale,
    BROWSER_USER_AGENT: options.browserUserAgent,
    CHROME_EXECUTABLE_PATH: options.chromeExecutablePath,
    ACCESS_TOKEN: options.accessToken,
    PUBLIC_ORIGIN: options.publicOrigin,
    CDP_PROXY: options.cdpProxy,
    CDP_PROXY_PATH: options.cdpProxyPath,
    SHUTDOWN_PATH: options.shutdownPath
  });

  logger.info("breamer container boot", {
    host: env.HOST,
    port: env.PORT,
    chromeDebugPort: env.CHROME_DEBUG_PORT,
    headless: env.HEADLESS,
    cdpProxy: env.CDP_PROXY,
    cdpProxyPath: env.CDP_PROXY_PATH,
    pageTimeoutMs: env.PAGE_TIMEOUT_MS,
    heapMb: env.CHROME_HEAP_SIZE_MB,
    viewport: `${env.BROWSER_WIDTH}x${env.BROWSER_HEIGHT}`,
    deviceScaleFactor: env.BROWSER_DEVICE_SCALE_FACTOR,
    locale: env.BROWSER_LOCALE,
    accessEnabled: Boolean(env.ACCESS_TOKEN)
  });

  let server: Server;

  const shutdown = async (reason = "request") => {
    logger.warn("shutting down", {
      reason,
      browserConnected: browser?.connected ?? false,
      pagesCreated: metrics.pagesCreated,
      pagesClosed: metrics.pagesClosed,
      cdpProxyConnections: metrics.cdpProxyConnections,
      cdpProxyErrors: metrics.cdpProxyErrors
    });
    server.close();
    if (browser) {
      await browser.close();
    }
    process.exit(0);
  };

  const app = createApp(env, {
    requestShutdown: () => {
      shutdown().catch((err) => {
        logger.error("Shutdown failed", err);
        process.exit(1);
      });
    }
  });

  ensureBrowser(env).catch((err) => {
    logger.error("Failed to launch browser", err);
  });

  server = serve({
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT
  }) as Server;

  if (env.CDP_PROXY) {
    installCdpProxy(server, env);
  }

  logger.success(`Server listening on http://${env.HOST}:${env.PORT}`);

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      logger.error("Shutdown failed", err);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      logger.error("Shutdown failed", err);
      process.exit(1);
    });
  });

  return { app, env, server };
};

export { type Env, parseEnv } from "./env.js";
export { logger } from "./logger.js";
