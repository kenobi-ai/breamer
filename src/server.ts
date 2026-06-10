import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
// pokayoke-ignore-file: structure/max-file-lines -- Worker-facing browser orchestration is intentionally kept together while the service surface is still compact.
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { WebSocket, WebSocketServer } from "ws";
import { type CdpRenderingDefaults, pipeWebSockets } from "./cdp-proxy.js";
import { type Env, parseEnv } from "./env.js";
import { logger } from "./logger.js";
import {
  buildDirectBrowserEndpoint,
  buildProxiedBrowserEndpoint,
  inferPublicOrigin,
} from "./urls.js";

type AppVariables = {
  requestId: string;
  sessionId?: string;
};

interface BrowserPersona {
  acceptLanguage: string;
  browserVersion: string;
  colorProfile: string;
  deviceMemoryGb: number;
  hardwareConcurrency: number;
  languages: string[];
  userAgent: string;
  userAgentMetadata: {
    architecture: string;
    bitness: string;
    brands: Array<{ brand: string; version: string }>;
    fullVersionList: Array<{ brand: string; version: string }>;
    mobile: boolean;
    model: string;
    platform: string;
    platformVersion: string;
    wow64: boolean;
  };
}

let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let activeBrowserPersona: BrowserPersona | null = null;

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
  cdpProxyErrors: 0,
  pageDefaultsApplied: 0,
  pageDefaultsFailed: 0,
  cdpRenderingDefaultsCompleted: 0,
  cdpRenderingDefaultsFailed: 0,
  cdpRenderingDefaultsTimedOut: 0,
  archiveSettleCompleted: 0,
  archiveSettleFailed: 0,
  archiveSettleTimedOut: 0,
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

const chromeVersionFrom = (value: string): string | undefined => {
  return /(?:Chrome|Chromium)\/([0-9.]+)/.exec(value)?.[1];
};

const buildMacChromeUserAgent = (env: Env, browserVersion: string): string => {
  if (env.BROWSER_USER_AGENT) {
    return env.BROWSER_USER_AGENT;
  }

  const chromeVersion = chromeVersionFrom(browserVersion) ?? "131.0.0.0";
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
};

const normalizeLanguages = (locale: string): string[] => {
  const languages = locale
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return languages.length > 0 ? languages : ["en-US", "en"];
};

const buildAcceptLanguageHeader = (languages: string[]): string => {
  return languages
    .map((language, index) => {
      if (index === 0) {
        return language;
      }

      const quality = Math.max(0.1, 1 - index * 0.1).toFixed(1);
      return `${language};q=${quality}`;
    })
    .join(",");
};

const buildBrowserPersona = (
  env: Env,
  browserVersion: string,
): BrowserPersona => {
  const userAgent = buildMacChromeUserAgent(env, browserVersion);
  const chromeVersion =
    chromeVersionFrom(userAgent) ?? chromeVersionFrom(browserVersion) ?? "131";
  const chromeMajor = chromeVersion.split(".")[0] ?? "131";
  const fullChromeVersion = chromeVersion.includes(".")
    ? chromeVersion
    : `${chromeMajor}.0.0.0`;
  const languages = normalizeLanguages(env.BROWSER_LOCALE);

  return {
    acceptLanguage: buildAcceptLanguageHeader(languages),
    browserVersion,
    colorProfile: env.BROWSER_COLOR_GAMUT === "p3" ? "display-p3-d65" : "srgb",
    deviceMemoryGb: env.BROWSER_DEVICE_MEMORY_GB,
    hardwareConcurrency: env.BROWSER_HARDWARE_CONCURRENCY,
    languages,
    userAgent,
    userAgentMetadata: {
      architecture: env.BROWSER_CLIENT_HINT_ARCHITECTURE,
      bitness: "64",
      brands: [
        { brand: "Chromium", version: chromeMajor },
        { brand: "Google Chrome", version: chromeMajor },
        { brand: "Not.A/Brand", version: "99" },
      ],
      fullVersionList: [
        { brand: "Chromium", version: fullChromeVersion },
        { brand: "Google Chrome", version: fullChromeVersion },
        { brand: "Not.A/Brand", version: "99.0.0.0" },
      ],
      mobile: false,
      model: "",
      platform: env.BROWSER_CLIENT_HINT_PLATFORM,
      platformVersion: env.BROWSER_CLIENT_HINT_PLATFORM_VERSION,
      wow64: false,
    },
  };
};

const buildCdpRenderingDefaults = (
  env: Env,
  persona: BrowserPersona,
): CdpRenderingDefaults => ({
  acceptLanguage: persona.acceptLanguage,
  colorGamut: env.BROWSER_COLOR_GAMUT,
  deviceMemoryGb: persona.deviceMemoryGb,
  deviceScaleFactor: env.BROWSER_DEVICE_SCALE_FACTOR,
  hardwareConcurrency: persona.hardwareConcurrency,
  height: env.BROWSER_HEIGHT,
  languages: persona.languages,
  platform: env.BROWSER_PLATFORM,
  prefersColorScheme: env.BROWSER_PREFERS_COLOR_SCHEME,
  prefersReducedMotion: env.BROWSER_PREFERS_REDUCED_MOTION,
  ...(env.BROWSER_TIMEZONE ? { timezone: env.BROWSER_TIMEZONE } : {}),
  userAgent: persona.userAgent,
  userAgentMetadata: persona.userAgentMetadata,
  width: env.BROWSER_WIDTH,
});

const applyPageRenderingDefaults = async (
  page: Page,
  env: Env,
  persona: BrowserPersona,
): Promise<void> => {
  await page.setViewport({
    width: env.BROWSER_WIDTH,
    height: env.BROWSER_HEIGHT,
    deviceScaleFactor: env.BROWSER_DEVICE_SCALE_FACTOR,
    isMobile: false,
    hasTouch: false,
  });

  await page.setUserAgent({
    userAgent: persona.userAgent,
    userAgentMetadata: persona.userAgentMetadata,
    platform: env.BROWSER_PLATFORM,
  });

  await page.setExtraHTTPHeaders({
    "Accept-Language": persona.acceptLanguage,
  });

  await page.emulateMediaType("screen");
  await page.emulateMediaFeatures([
    { name: "color-gamut", value: env.BROWSER_COLOR_GAMUT },
    { name: "prefers-color-scheme", value: env.BROWSER_PREFERS_COLOR_SCHEME },
    {
      name: "prefers-reduced-motion",
      value: env.BROWSER_PREFERS_REDUCED_MOTION,
    },
  ]);

  if (env.BROWSER_TIMEZONE) {
    await page.emulateTimezone(env.BROWSER_TIMEZONE);
  }

  await page.evaluateOnNewDocument(
    (
      deviceMemoryGb: number,
      hardwareConcurrency: number,
      height: number,
      platform: string,
      languages: string[],
      width: number,
    ) => {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => languages[0],
      });
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        get: () => platform,
      });
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => languages,
      });
      Object.defineProperty(navigator, "webdriver", {
        configurable: true,
        get: () => undefined,
      });
      Object.defineProperty(navigator, "hardwareConcurrency", {
        configurable: true,
        get: () => hardwareConcurrency,
      });
      Object.defineProperty(navigator, "deviceMemory", {
        configurable: true,
        get: () => deviceMemoryGb,
      });
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        get: () => 0,
      });
      Object.defineProperty(navigator, "pdfViewerEnabled", {
        configurable: true,
        get: () => true,
      });
      Object.defineProperty(navigator, "vendor", {
        configurable: true,
        get: () => "Google Inc.",
      });
      Object.defineProperty(screen, "width", {
        configurable: true,
        get: () => width,
      });
      Object.defineProperty(screen, "height", {
        configurable: true,
        get: () => height,
      });
      Object.defineProperty(screen, "availWidth", {
        configurable: true,
        get: () => width,
      });
      Object.defineProperty(screen, "availHeight", {
        configurable: true,
        get: () => height,
      });
    },
    persona.deviceMemoryGb,
    persona.hardwareConcurrency,
    env.BROWSER_HEIGHT,
    env.BROWSER_PLATFORM,
    persona.languages,
    env.BROWSER_WIDTH,
  );

  const client = await page.createCDPSession();
  await Promise.allSettled([
    client.send("Emulation.setLocaleOverride", {
      locale: persona.languages[0],
    }),
    client.send("Emulation.setNavigatorOverrides", {
      platform: env.BROWSER_PLATFORM,
    }),
    client.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
    client.send("Emulation.setIdleOverride", {
      isUserActive: true,
      isScreenUnlocked: true,
    }),
  ]);
  await client.detach().catch(() => undefined);
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
  path: c.req.path,
});

const headerValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

export const buildChromeLaunchArgs = (env: Env): string[] => [
  `--remote-debugging-port=${env.CHROME_DEBUG_PORT}`,
  "--remote-debugging-address=0.0.0.0",
  `--window-size=${env.BROWSER_WIDTH},${env.BROWSER_HEIGHT}`,
  `--force-device-scale-factor=${env.BROWSER_DEVICE_SCALE_FACTOR}`,
  `--lang=${normalizeLanguages(env.BROWSER_LOCALE)[0] ?? "en-US"}`,
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
  "--disable-blink-features=AutomationControlled",
  "--disable-breakpad",
  "--disable-component-update",
  "--enable-font-antialiasing",
  "--font-render-hinting=none",
  "--enable-accelerated-2d-canvas",
  "--enable-webgl",
  "--enable-webgl2",
  "--ignore-gpu-blocklist",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  `--force-color-profile=${
    env.BROWSER_COLOR_GAMUT === "p3" ? "display-p3-d65" : "srgb"
  }`,
  "--high-dpi-support=1",
  "--run-all-compositor-stages-before-draw",
  `--user-agent=${buildMacChromeUserAgent(env, "Chrome/131.0.0.0")}`,
];

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
    userAgentOverride: Boolean(env.BROWSER_USER_AGENT),
  });

  const launchedBrowser = await puppeteer.launch({
    executablePath,
    headless: env.HEADLESS,
    defaultViewport: {
      width: env.BROWSER_WIDTH,
      height: env.BROWSER_HEIGHT,
      deviceScaleFactor: env.BROWSER_DEVICE_SCALE_FACTOR,
    },
    args: buildChromeLaunchArgs(env),
  });

  browser = launchedBrowser;
  const browserVersion = await launchedBrowser
    .version()
    .catch(() => "Chrome/131.0.0.0");
  const browserPersona = buildBrowserPersona(env, browserVersion);
  activeBrowserPersona = browserPersona;

  logger.browser("persona", {
    browserVersion,
    userAgent: browserPersona.userAgent,
    platform: env.BROWSER_PLATFORM,
    clientHintPlatform: env.BROWSER_CLIENT_HINT_PLATFORM,
    clientHintArchitecture: env.BROWSER_CLIENT_HINT_ARCHITECTURE,
    colorGamut: env.BROWSER_COLOR_GAMUT,
    colorProfile: browserPersona.colorProfile,
    hardwareConcurrency: browserPersona.hardwareConcurrency,
    deviceMemoryGb: browserPersona.deviceMemoryGb,
    deviceScaleFactor: env.BROWSER_DEVICE_SCALE_FACTOR,
  });

  launchedBrowser.on("disconnected", () => {
    logger.browser("disconnected", {
      pagesCreated: metrics.pagesCreated,
      pagesClosed: metrics.pagesClosed,
      cdpProxyConnections: metrics.cdpProxyConnections,
    });
    if (browser === launchedBrowser) {
      browser = null;
      activeBrowserPersona = null;
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

      page.setDefaultTimeout(env.PAGE_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(env.PAGE_TIMEOUT_MS);

      try {
        await applyPageRenderingDefaults(page, env, browserPersona);
        metrics.pageDefaultsApplied++;
      } catch (error) {
        metrics.pageDefaultsFailed++;
        logger.target("render defaults failed", type, describeError(error));
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
    wsEndpoint: launchedBrowser.wsEndpoint(),
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
      `http://${request.headers.host ?? "localhost"}`,
    );
    const requestId = headerValue(request.headers["x-breamer-request-id"]);
    const sessionId = headerValue(request.headers["x-breamer-session-id"]);

    const prefix = `${env.CDP_PROXY_PATH}/`;
    if (!requestUrl.pathname.startsWith(prefix)) {
      logger.cdp("proxy rejected", {
        requestId,
        sessionId,
        path: requestUrl.pathname,
        expectedPrefix: prefix,
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
        const renderingDefaults = activeBrowserPersona
          ? buildCdpRenderingDefaults(env, activeBrowserPersona)
          : undefined;

        metrics.cdpProxyConnections++;
        logger.cdp("proxy connect", {
          requestId,
          sessionId,
          path: requestUrl.pathname,
          targetUrl,
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
            reason: reason.toString(),
          });
        });
        upstream.once("close", (code, reason) => {
          logger.cdp("upstream close", {
            requestId,
            sessionId,
            code,
            reason: reason.toString(),
          });
        });
        pipeWebSockets(client, upstream, {
          archiveSettleTimeoutMs: env.ARCHIVE_SETTLE_TIMEOUT_MS,
          autoScrollBeforeCaptureSnapshot:
            env.ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE,
          rasterizeDynamicMediaBeforeCapture:
            env.ARCHIVE_RASTERIZE_DYNAMIC_MEDIA,
          ...(renderingDefaults ? { renderingDefaults } : {}),
          renderingDefaultsTimeoutMs: 1500,
          settleBeforeCaptureSnapshot: env.ARCHIVE_SETTLE_BEFORE_CAPTURE,
          onRenderingDefaults: (details) => {
            if (details.status === "completed") {
              metrics.cdpRenderingDefaultsCompleted++;
            } else if (details.status === "timeout") {
              metrics.cdpRenderingDefaultsTimedOut++;
            } else {
              metrics.cdpRenderingDefaultsFailed++;
            }

            logger.cdp("rendering defaults", {
              requestId,
              connectionSessionId: sessionId,
              ...details,
            });
          },
          onArchiveSettle: (details) => {
            if (details.status === "completed") {
              metrics.archiveSettleCompleted++;
            } else if (details.status === "timeout") {
              metrics.archiveSettleTimedOut++;
            } else {
              metrics.archiveSettleFailed++;
            }

            logger.cdp("archive settle", {
              requestId,
              sessionId,
              ...details,
            });
          },
          onUpstreamError: (err) => {
            metrics.cdpProxyErrors++;
            logger.error(
              "CDP upstream error",
              `${targetUrl} ${describeError(err)}`,
            );
          },
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
  queryName = "token",
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
      tokenProvided: Boolean(token),
    });
    return c.json({ error: "unauthorized" }, 401);
  }
};

const readPublicPath = (
  c: Context,
  headerName: string,
  fallbackPath: string,
): string => {
  const value = c.req.header(headerName) ?? fallbackPath;
  return value.startsWith("/") ? value : `/${value}`;
};

export const createApp = (env: Env, options: CreateAppOptions = {}) => {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", cors());

  app.use("*", async (c, next) => {
    const start = performance.now();
    const requestId =
      c.req.header("x-breamer-request-id") ?? crypto.randomUUID();
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
        userAgent: c.req.header("user-agent"),
      },
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
      uptimeMs,
    });

    return c.json({
      status: isConnected ? "healthy" : "starting",
      browser: {
        connected: isConnected,
        debugPort: env.CHROME_DEBUG_PORT,
        openPages: pages.length,
        pageTimeoutMs: env.PAGE_TIMEOUT_MS,
        archiveSettleBeforeCapture: env.ARCHIVE_SETTLE_BEFORE_CAPTURE,
        archiveAutoScrollBeforeCapture: env.ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE,
        archiveSettleTimeoutMs: env.ARCHIVE_SETTLE_TIMEOUT_MS,
        archiveRasterizeDynamicMedia: env.ARCHIVE_RASTERIZE_DYNAMIC_MEDIA,
        renderingDefaults: {
          userAgent: activeBrowserPersona?.userAgent ?? null,
          platform: env.BROWSER_PLATFORM,
          clientHintPlatform: env.BROWSER_CLIENT_HINT_PLATFORM,
          clientHintArchitecture: env.BROWSER_CLIENT_HINT_ARCHITECTURE,
          colorGamut: env.BROWSER_COLOR_GAMUT,
          hardwareConcurrency: env.BROWSER_HARDWARE_CONCURRENCY,
          deviceMemoryGb: env.BROWSER_DEVICE_MEMORY_GB,
          prefersColorScheme: env.BROWSER_PREFERS_COLOR_SCHEME,
          prefersReducedMotion: env.BROWSER_PREFERS_REDUCED_MOTION,
          timezone: env.BROWSER_TIMEZONE ?? null,
        },
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
        cdpProxyErrors: metrics.cdpProxyErrors,
        pageDefaultsApplied: metrics.pageDefaultsApplied,
        pageDefaultsFailed: metrics.pageDefaultsFailed,
        cdpRenderingDefaultsCompleted: metrics.cdpRenderingDefaultsCompleted,
        cdpRenderingDefaultsFailed: metrics.cdpRenderingDefaultsFailed,
        cdpRenderingDefaultsTimedOut: metrics.cdpRenderingDefaultsTimedOut,
        archiveSettleCompleted: metrics.archiveSettleCompleted,
        archiveSettleFailed: metrics.archiveSettleFailed,
        archiveSettleTimedOut: metrics.archiveSettleTimedOut,
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
        accessEnabled: Boolean(env.ACCESS_TOKEN),
      },
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
        connected: browser?.connected ?? false,
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
        env.CDP_PROXY_PATH,
      );
      const publicShutdownPath = readPublicPath(
        c,
        "x-breamer-public-shutdown-path",
        env.SHUTDOWN_PATH,
      );
      const publicOrigin = inferPublicOrigin(c, env);
      const shutdownUrl = new URL(publicShutdownPath, publicOrigin);

      if (!env.CDP_PROXY && env.BROWSER_HOSTNAME) {
        const wsEndpoint = buildDirectBrowserEndpoint(localEndpoint, env);
        logger.cdp("endpoint issued", {
          ...requestLogContext(c),
          mode: "direct",
          wsEndpoint,
          shutdownUrl: shutdownUrl.toString(),
        });
        return c.json({
          wsEndpoint,
          shutdownUrl: shutdownUrl.toString(),
          ...(sessionId ? { sessionId } : {}),
          mode: "direct",
          path: new URL(wsEndpoint).pathname,
        });
      }

      const endpoint = buildProxiedBrowserEndpoint(
        localEndpoint,
        publicOrigin,
        env,
        publicCdpPath,
      );

      logger.cdp("endpoint issued", {
        ...requestLogContext(c),
        mode: "proxy",
        publicOrigin,
        wsEndpoint: endpoint.wsEndpoint,
        shutdownUrl: shutdownUrl.toString(),
        proxyPath: endpoint.proxyPath,
        localPath: endpoint.localPath,
      });

      return c.json({
        wsEndpoint: endpoint.wsEndpoint,
        shutdownUrl: shutdownUrl.toString(),
        ...(sessionId ? { sessionId } : {}),
        mode: "proxy",
        path: endpoint.proxyPath,
        localPath: endpoint.localPath,
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

interface StartServerOptions {
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
  browserPlatform?: string;
  browserClientHintPlatform?: string;
  browserClientHintArchitecture?: string;
  browserClientHintPlatformVersion?: string;
  browserColorGamut?: Env["BROWSER_COLOR_GAMUT"];
  browserHardwareConcurrency?: number;
  browserDeviceMemoryGb?: number;
  browserPrefersColorScheme?: Env["BROWSER_PREFERS_COLOR_SCHEME"];
  browserPrefersReducedMotion?: Env["BROWSER_PREFERS_REDUCED_MOTION"];
  browserTimezone?: string;
  archiveSettleBeforeCapture?: boolean;
  archiveAutoScrollBeforeCapture?: boolean;
  archiveSettleTimeoutMs?: number;
  archiveRasterizeDynamicMedia?: boolean;
  chromeExecutablePath?: string;
  publicOrigin?: string;
  cdpProxy?: boolean;
  cdpProxyPath?: string;
  accessToken?: string;
  shutdownPath?: string;
}

const startServer = async (options: StartServerOptions = {}) => {
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
    BROWSER_PLATFORM: options.browserPlatform,
    BROWSER_CLIENT_HINT_PLATFORM: options.browserClientHintPlatform,
    BROWSER_CLIENT_HINT_ARCHITECTURE: options.browserClientHintArchitecture,
    BROWSER_CLIENT_HINT_PLATFORM_VERSION:
      options.browserClientHintPlatformVersion,
    BROWSER_COLOR_GAMUT: options.browserColorGamut,
    BROWSER_HARDWARE_CONCURRENCY: options.browserHardwareConcurrency,
    BROWSER_DEVICE_MEMORY_GB: options.browserDeviceMemoryGb,
    BROWSER_PREFERS_COLOR_SCHEME: options.browserPrefersColorScheme,
    BROWSER_PREFERS_REDUCED_MOTION: options.browserPrefersReducedMotion,
    BROWSER_TIMEZONE: options.browserTimezone,
    ARCHIVE_SETTLE_BEFORE_CAPTURE: options.archiveSettleBeforeCapture,
    ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE: options.archiveAutoScrollBeforeCapture,
    ARCHIVE_SETTLE_TIMEOUT_MS: options.archiveSettleTimeoutMs,
    ARCHIVE_RASTERIZE_DYNAMIC_MEDIA: options.archiveRasterizeDynamicMedia,
    CHROME_EXECUTABLE_PATH: options.chromeExecutablePath,
    ACCESS_TOKEN: options.accessToken,
    PUBLIC_ORIGIN: options.publicOrigin,
    CDP_PROXY: options.cdpProxy,
    CDP_PROXY_PATH: options.cdpProxyPath,
    SHUTDOWN_PATH: options.shutdownPath,
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
    platform: env.BROWSER_PLATFORM,
    clientHintPlatform: env.BROWSER_CLIENT_HINT_PLATFORM,
    colorGamut: env.BROWSER_COLOR_GAMUT,
    hardwareConcurrency: env.BROWSER_HARDWARE_CONCURRENCY,
    deviceMemoryGb: env.BROWSER_DEVICE_MEMORY_GB,
    prefersColorScheme: env.BROWSER_PREFERS_COLOR_SCHEME,
    archiveSettleBeforeCapture: env.ARCHIVE_SETTLE_BEFORE_CAPTURE,
    archiveAutoScrollBeforeCapture: env.ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE,
    archiveSettleTimeoutMs: env.ARCHIVE_SETTLE_TIMEOUT_MS,
    archiveRasterizeDynamicMedia: env.ARCHIVE_RASTERIZE_DYNAMIC_MEDIA,
    accessEnabled: Boolean(env.ACCESS_TOKEN),
  });

  let server: Server;

  const shutdown = async (reason = "request") => {
    logger.warn("shutting down", {
      reason,
      browserConnected: browser?.connected ?? false,
      pagesCreated: metrics.pagesCreated,
      pagesClosed: metrics.pagesClosed,
      cdpProxyConnections: metrics.cdpProxyConnections,
      cdpProxyErrors: metrics.cdpProxyErrors,
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
    },
  });

  ensureBrowser(env).catch((err) => {
    logger.error("Failed to launch browser", err);
  });

  server = serve({
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    logger.error("Container process failed", error);
    process.exit(1);
  });
}

export { type Env, parseEnv } from "./env.js";
