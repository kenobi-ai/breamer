#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import {
  buildArchiveSettleExpression,
  embedExternalFontResourcesInMhtml,
} from "../src/cdp-proxy.ts";

type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

interface CliOptions {
  accessToken: string;
  blockAnnoyances: boolean;
  blockImages: boolean;
  extraWaitMs: number;
  headers: Record<string, string>;
  outputDir: string;
  outputPath?: string;
  scroll: boolean;
  serviceUrl: string;
  snapshotTimeoutMs: number;
  targetUrl: string;
  userAgent?: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
  };
  waitForSelector?: string;
  waitTimeoutMs: number;
  waitUntil: WaitUntil;
}

interface CdpSessionResponse {
  wsEndpoint: string;
  shutdownUrl: string;
  sessionId?: string;
  mode?: string;
}

const DEFAULT_BREAMER_URL = "https://breamer.kenobi.ai";
const CMP_DOMAINS = [
  "cdn.cookielaw.org",
  "cookiebot.com",
  "cookiebot.eu",
  "consentmanager.net",
  "didomi.io",
  "onetrust.com",
  "privacy-mgmt.com",
  "quantcast.mgr.consensu.org",
  "trustarc.com",
  "usercentrics.eu",
];

const ANNOYANCE_CSS = `
  #onetrust-banner-sdk,
  #onetrust-consent-sdk,
  #CybotCookiebotDialog,
  [data-testid*="cookie" i],
  [aria-label*="cookie" i],
  [id*="cookie-banner" i],
  [id*="cookie-consent" i],
  [class*="cookie-banner" i],
  [class*="cookie-consent" i] {
    display: none !important;
    visibility: hidden !important;
  }
`;

const usage = `Usage:
  bun run capture:mhtml -- --live-url <page-url> --token <access-token>
  bun run capture:mhtml -- <page-url> <access-token>
  bun run capture:mhtml -- <breamer-url> <access-token> <page-url>

Options:
  --live-url, --url, --target-url <url>     Page URL to archive
  --token, --access-token <token>          Breamer access token
  --service-url, --breamer-url <url>       Breamer root URL (${DEFAULT_BREAMER_URL})
  --out-dir, --output-dir, --folder <dir>  Folder for generated archives (mhtml-archives)
  --output, --out <path>                   Exact output .mhtml path
  --viewport <width>x<height>              Viewport size (1470x956)
  --device-scale-factor <number>           Device scale factor (2)
  --wait-until <event>                     load, domcontentloaded, networkidle0, networkidle2 (networkidle2)
  --wait-timeout-ms <ms>                   Navigation/selector timeout (60000)
  --snapshot-timeout-ms <ms>               MHTML snapshot timeout (120000)
  --extra-wait-ms <ms>                     Extra settling delay after navigation (1000)
  --wait-for-selector <selector>           Wait for app-specific content before capture
  --header <name:value>                    Extra target-page header; repeatable
  --user-agent <value>                     Override the service's default Mac Chrome user agent
  --no-scroll                              Do not scroll before capture
  --no-block-annoyances                    Do not block common cookie/CMP annoyances
  --block-images                           Abort image requests to reduce memory
`;

const isUsageError = (message: string): boolean =>
  message.startsWith("Missing ") ||
  message.startsWith("Unknown option:") ||
  message.startsWith("Use either ") ||
  /^--[\w-]+ /.test(message);

const takeValue = (
  args: string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } => {
  const equalsIndex = option.indexOf("=");
  if (equalsIndex !== -1) {
    return {
      value: option.slice(equalsIndex + 1),
      nextIndex: index,
    };
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }

  return { value, nextIndex: index + 1 };
};

const parsePositiveInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
};

const parseNonNegativeInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
};

const parsePositiveNumber = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return parsed;
};

const parseWaitUntil = (value: string): WaitUntil => {
  if (
    value === "load" ||
    value === "domcontentloaded" ||
    value === "networkidle0" ||
    value === "networkidle2"
  ) {
    return value;
  }

  throw new Error(
    "--wait-until must be load, domcontentloaded, networkidle0, or networkidle2",
  );
};

const parseViewport = (
  value: string,
): {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: false;
} => {
  const match = /^(\d+)x(\d+)$/i.exec(value);
  if (!match) {
    throw new Error("--viewport must look like 1440x900");
  }

  return {
    width: parsePositiveInteger(match[1] ?? "", "viewport width"),
    height: parsePositiveInteger(match[2] ?? "", "viewport height"),
    deviceScaleFactor: 1,
    isMobile: false,
  };
};

const parseHeader = (value: string): [string, string] => {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    throw new Error("--header must look like 'Name: value'");
  }

  const name = value.slice(0, separatorIndex).trim();
  const headerValue = value.slice(separatorIndex + 1).trim();
  if (!name || !headerValue) {
    throw new Error("--header must include a non-empty name and value");
  }

  return [name, headerValue];
};

const normalizeRootUrl = (value: string): string => {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

const buildCdpUrl = (serviceUrl: string): string => {
  const parsed = new URL(serviceUrl);
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = normalizedPath.endsWith("/cdp")
    ? normalizedPath
    : `${normalizedPath}/cdp`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const sanitizeFilename = (value: string): string =>
  value
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .toLowerCase();

const defaultOutputPath = (targetUrl: string, outputDir: string): string => {
  const parsed = new URL(targetUrl);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pathPart = sanitizeFilename(`${parsed.hostname}${parsed.pathname}`);
  const fileName = `${pathPart || "archive"}-${stamp}.mhtml`;
  return path.resolve(outputDir, fileName);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const parseArgs = (argv: string[]): CliOptions => {
  const options: Omit<CliOptions, "accessToken" | "targetUrl"> & {
    accessToken?: string;
    targetUrl?: string;
  } = {
    blockAnnoyances: true,
    blockImages: false,
    extraWaitMs: 1000,
    headers: {},
    outputDir: "mhtml-archives",
    scroll: true,
    serviceUrl: process.env.BREAMER_ROOT_URL ?? DEFAULT_BREAMER_URL,
    snapshotTimeoutMs: 120_000,
    viewport: {
      width: 1470,
      height: 956,
      deviceScaleFactor: 2,
      isMobile: false,
    },
    waitTimeoutMs: 60_000,
    waitUntil: "networkidle2",
  };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (optionName) {
      case "--access-token":
      case "--token": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.accessToken = value;
        index = nextIndex;
        break;
      }
      case "--breamer-url":
      case "--root-url":
      case "--service-url": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.serviceUrl = value;
        index = nextIndex;
        break;
      }
      case "--folder":
      case "--out-dir":
      case "--output-dir": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.outputDir = value;
        index = nextIndex;
        break;
      }
      case "--out":
      case "--output": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.outputPath = value;
        index = nextIndex;
        break;
      }
      case "--live-url":
      case "--target-url":
      case "--url": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.targetUrl = value;
        index = nextIndex;
        break;
      }
      case "--viewport": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        const { deviceScaleFactor } = options.viewport;
        options.viewport = {
          ...parseViewport(value),
          deviceScaleFactor,
        };
        index = nextIndex;
        break;
      }
      case "--device-scale-factor": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.viewport.deviceScaleFactor = parsePositiveNumber(
          value,
          "device scale factor",
        );
        index = nextIndex;
        break;
      }
      case "--wait-until": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.waitUntil = parseWaitUntil(value);
        index = nextIndex;
        break;
      }
      case "--wait-timeout-ms": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.waitTimeoutMs = parsePositiveInteger(value, "wait timeout");
        index = nextIndex;
        break;
      }
      case "--snapshot-timeout-ms": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.snapshotTimeoutMs = parsePositiveInteger(
          value,
          "snapshot timeout",
        );
        index = nextIndex;
        break;
      }
      case "--extra-wait-ms": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.extraWaitMs = parseNonNegativeInteger(value, "extra wait");
        index = nextIndex;
        break;
      }
      case "--wait-for-selector": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.waitForSelector = value;
        index = nextIndex;
        break;
      }
      case "--header": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        const [name, headerValue] = parseHeader(value);
        options.headers[name] = headerValue;
        index = nextIndex;
        break;
      }
      case "--user-agent": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.userAgent = value;
        index = nextIndex;
        break;
      }
      case "--block-annoyances":
        options.blockAnnoyances = true;
        break;
      case "--no-block-annoyances":
        options.blockAnnoyances = false;
        break;
      case "--block-images":
        options.blockImages = true;
        break;
      case "--no-block-images":
        options.blockImages = false;
        break;
      case "--scroll":
        options.scroll = true;
        break;
      case "--no-scroll":
        options.scroll = false;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (positional.length === 2) {
    options.targetUrl ??= positional[0];
    options.accessToken ??= positional[1];
  } else if (positional.length === 3) {
    options.serviceUrl = positional[0] ?? options.serviceUrl;
    options.accessToken ??= positional[1];
    options.targetUrl ??= positional[2];
  } else if (positional.length > 0) {
    throw new Error("Use either 2 positional args or 3 positional args");
  }

  options.accessToken ??= process.env.BREAMER_ACCESS_TOKEN;

  if (!options.targetUrl) {
    throw new Error(
      "Missing page URL. Pass --live-url <url> or a positional URL.",
    );
  }

  if (!options.accessToken) {
    throw new Error("Missing access token. Pass --token <token>.");
  }

  return {
    ...options,
    accessToken: options.accessToken,
    serviceUrl: normalizeRootUrl(options.serviceUrl),
    targetUrl: new URL(options.targetUrl).toString(),
  };
};

const requestBreamerSession = async (
  options: CliOptions,
): Promise<CdpSessionResponse> => {
  const cdpUrl = buildCdpUrl(options.serviceUrl);
  const response = await fetch(cdpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create Breamer session: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as Partial<CdpSessionResponse>;
  if (typeof body.wsEndpoint !== "string") {
    throw new Error("Breamer response did not include wsEndpoint");
  }
  if (typeof body.shutdownUrl !== "string") {
    throw new Error("Breamer response did not include shutdownUrl");
  }

  return {
    wsEndpoint: body.wsEndpoint,
    shutdownUrl: body.shutdownUrl,
    ...(typeof body.sessionId === "string"
      ? { sessionId: body.sessionId }
      : {}),
    ...(typeof body.mode === "string" ? { mode: body.mode } : {}),
  };
};

const installRequestBlocking = async (
  page: Page,
  options: CliOptions,
): Promise<void> => {
  if (!options.blockAnnoyances && !options.blockImages) {
    return;
  }

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (options.blockImages && request.resourceType() === "image") {
      request.abort().catch(() => undefined);
      return;
    }

    if (
      options.blockAnnoyances &&
      CMP_DOMAINS.some((domain) => request.url().toLowerCase().includes(domain))
    ) {
      request.abort().catch(() => undefined);
      return;
    }

    request.continue().catch(() => undefined);
  });
};

const autoScroll = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const documentElement = document.documentElement;
    const body = document.body;
    const maxHeight = Math.max(
      body?.scrollHeight ?? 0,
      documentElement.scrollHeight,
      body?.offsetHeight ?? 0,
      documentElement.offsetHeight,
      body?.clientHeight ?? 0,
      documentElement.clientHeight,
    );
    const step = Math.max(Math.round(window.innerHeight * 0.75), 400);

    for (let top = 0; top < maxHeight; top += step) {
      window.scrollTo(0, top);
      await wait(100);
    }

    window.scrollTo(0, 0);
    await wait(250);
  });
};

const settlePage = async (page: Page, timeoutMs: number): Promise<void> => {
  await Promise.race([
    page.evaluate(() => document.fonts?.ready ?? Promise.resolve()),
    delay(timeoutMs),
  ]);

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
};

const settlePageForArchive = async (
  page: Page,
  timeoutMs: number,
  autoScrollBeforeCapture: boolean,
): Promise<unknown> => {
  return await page.evaluate(
    buildArchiveSettleExpression(timeoutMs, autoScrollBeforeCapture, true),
  );
};

const readBrowserFingerprint = async (page: Page): Promise<unknown> => {
  return await page.evaluate(async () => {
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      pdfViewerEnabled?: boolean;
      userAgentData?: {
        brands: Array<{ brand: string; version: string }>;
        getHighEntropyValues: (
          hints: string[],
        ) => Promise<Record<string, unknown>>;
        mobile: boolean;
        platform: string;
      };
      webdriver?: boolean;
    };
    const chromeObject = (window as Window & { chrome?: unknown }).chrome;
    const highEntropyUserAgentData = nav.userAgentData
      ? await nav.userAgentData
          .getHighEntropyValues([
            "architecture",
            "bitness",
            "fullVersionList",
            "model",
            "platform",
            "platformVersion",
            "wow64",
          ])
          .catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
      : null;

    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: nav.deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints,
      pdfViewerEnabled: nav.pdfViewerEnabled ?? null,
      vendor: navigator.vendor,
      webdriverIsUndefined: typeof nav.webdriver === "undefined",
      webdriver: typeof nav.webdriver === "undefined" ? null : nav.webdriver,
      pluginsLength: navigator.plugins.length,
      mimeTypesLength: navigator.mimeTypes.length,
      chromeObjectKeys:
        typeof chromeObject === "object" && chromeObject !== null
          ? Object.keys(chromeObject).sort()
          : null,
      userAgentData: nav.userAgentData
        ? {
            brands: nav.userAgentData.brands,
            mobile: nav.userAgentData.mobile,
            platform: nav.userAgentData.platform,
            highEntropy: highEntropyUserAgentData,
          }
        : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      },
      viewport: {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
      },
      media: {
        colorGamutP3: matchMedia("(color-gamut: p3)").matches,
        colorGamutSrgb: matchMedia("(color-gamut: srgb)").matches,
        prefersColorSchemeLight: matchMedia("(prefers-color-scheme: light)")
          .matches,
        prefersColorSchemeDark: matchMedia("(prefers-color-scheme: dark)")
          .matches,
        prefersReducedMotionNoPreference: matchMedia(
          "(prefers-reduced-motion: no-preference)",
        ).matches,
        prefersReducedMotionReduce: matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches,
      },
    };
  });
};

const captureMhtml = async (options: CliOptions): Promise<void> => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let shutdownUrl: string | undefined;

  try {
    console.log(
      `Creating Breamer session at ${buildCdpUrl(options.serviceUrl)}`,
    );
    const session = await requestBreamerSession(options);
    shutdownUrl = session.shutdownUrl;
    console.log(
      `Connected session${session.sessionId ? ` ${session.sessionId}` : ""}${
        session.mode ? ` (${session.mode})` : ""
      }`,
    );

    browser = await puppeteer.connect({
      browserWSEndpoint: session.wsEndpoint,
      defaultViewport: null,
    });
    page = await browser.newPage();

    if (Object.keys(options.headers).length > 0) {
      await page.setExtraHTTPHeaders(options.headers);
    }

    if (options.userAgent) {
      await page.setUserAgent(options.userAgent);
    }
    await page.setViewport(options.viewport);
    await installRequestBlocking(page, options);

    console.log(`Opening ${options.targetUrl}`);
    await page.goto(options.targetUrl, {
      timeout: options.waitTimeoutMs,
      waitUntil: options.waitUntil,
    });

    if (options.waitForSelector) {
      console.log(`Waiting for selector ${options.waitForSelector}`);
      await page.waitForSelector(options.waitForSelector, {
        timeout: options.waitTimeoutMs,
      });
    }

    if (options.scroll) {
      console.log("Scrolling page to trigger lazy content");
      await autoScroll(page);
    }

    if (options.extraWaitMs > 0) {
      await delay(options.extraWaitMs);
    }

    if (options.blockAnnoyances) {
      await page.addStyleTag({ content: ANNOYANCE_CSS });
    }

    await settlePage(page, Math.min(options.waitTimeoutMs, 5000));
    console.log("Settling archive resources");
    const archiveSettle = await settlePageForArchive(
      page,
      Math.min(options.waitTimeoutMs, 10_000),
      false,
    );

    const fingerprint = await readBrowserFingerprint(page);
    const title = await page.title();
    const finalUrl = page.url();
    const client = await page.createCDPSession();
    await client.send("Page.enable");

    console.log("Capturing MHTML snapshot");
    const snapshot = await withTimeout(
      client.send("Page.captureSnapshot", {
        format: "mhtml",
      }) as Promise<{ data: string }>,
      options.snapshotTimeoutMs,
      `Timed out after ${options.snapshotTimeoutMs}ms while capturing MHTML`,
    );
    console.log("Embedding external font resources");
    const embeddedSnapshot = await embedExternalFontResourcesInMhtml(
      snapshot.data,
    );

    const outputPath = path.resolve(
      options.outputPath ??
        defaultOutputPath(options.targetUrl, options.outputDir),
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, embeddedSnapshot.data);

    const archiveSize = Buffer.byteLength(embeddedSnapshot.data, "utf8");
    console.log(
      JSON.stringify(
        {
          archiveSize,
          archiveSizeMb: Number((archiveSize / 1024 / 1024).toFixed(2)),
          archiveSettle,
          embeddedFonts: embeddedSnapshot.fonts,
          fingerprint,
          finalUrl,
          outputPath,
          title,
        },
        null,
        2,
      ),
    );
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }

    if (browser) {
      browser.disconnect();
    }

    if (shutdownUrl) {
      const response = await fetch(shutdownUrl, { method: "POST" }).catch(
        (error: unknown) => {
          console.warn(`Failed to request Breamer shutdown: ${String(error)}`);
          return undefined;
        },
      );
      if (response && !response.ok) {
        console.warn(
          `Breamer shutdown returned ${response.status}: ${await response.text()}`,
        );
      }
    }
  }
};

try {
  await captureMhtml(parseArgs(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.BREAMER_CAPTURE_DEBUG === "1" && error instanceof Error) {
    console.error(error.stack);
  }
  if (isUsageError(message)) {
    console.error("");
    console.error(usage);
  }
  process.exit(1);
}
