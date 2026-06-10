#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

interface CliOptions {
  accessToken: string;
  breamerServiceUrl: string;
  extraWaitMs: number;
  fullPage: boolean;
  outputDir: string;
  referenceHttpUrl?: string;
  referenceWsEndpoint?: string;
  targetUrl: string;
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

interface CaptureResult {
  fingerprint: unknown;
  finalUrl: string;
  screenshot: Uint8Array;
  title: string;
}

interface PixelDiff {
  comparedPixels: number;
  dimensions: {
    breamer: { width: number; height: number };
    reference: { width: number; height: number };
  };
  exactPixelMatchRate: number;
  maxChannelDelta: number;
  meanAbsoluteChannelDelta: number;
  pixelsOverThreshold: number;
  pixelsOverThresholdRate: number;
  rmsChannelDelta: number;
  threshold: number;
}

const DEFAULT_BREAMER_URL = "https://breamer.kenobi.ai";

const usage = `Usage:
  bun run compare:rendering -- --url <page-url> --token <access-token> --reference-ws <ws-endpoint>
  bun run compare:rendering -- --url <page-url> --token <access-token> --reference-http http://127.0.0.1:9222

Options:
  --url, --target-url <url>                Page URL to compare
  --token, --access-token <token>          Breamer access token
  --service-url, --breamer-url <url>       Breamer root URL (${DEFAULT_BREAMER_URL})
  --reference-ws <endpoint>                Existing Mac Chrome browser WebSocket endpoint
  --reference-http <url>                   Existing Mac Chrome remote-debugging HTTP root
  --out-dir, --output-dir, --folder <dir>  Folder for comparison artifacts (render-comparisons)
  --viewport <width>x<height>              Viewport size (1470x956)
  --device-scale-factor <number>           Device scale factor (2)
  --wait-until <event>                     load, domcontentloaded, networkidle0, networkidle2 (networkidle2)
  --wait-timeout-ms <ms>                   Navigation/selector timeout (60000)
  --extra-wait-ms <ms>                     Extra settling delay after navigation (1000)
  --wait-for-selector <selector>           Wait for app-specific content before capture
  --full-page                              Compare full-page screenshots instead of viewport
`;

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

const parsePositiveNumber = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
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
    throw new Error("--viewport must look like 1470x956");
  }

  return {
    width: parsePositiveInteger(match[1] ?? "", "viewport width"),
    height: parsePositiveInteger(match[2] ?? "", "viewport height"),
    deviceScaleFactor: 1,
    isMobile: false,
  };
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

const artifactBasePath = (targetUrl: string, outputDir: string): string => {
  const parsed = new URL(targetUrl);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pathPart = sanitizeFilename(`${parsed.hostname}${parsed.pathname}`);
  return path.resolve(outputDir, `${pathPart || "render"}-${stamp}`);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv: string[]): CliOptions => {
  const options: Partial<CliOptions> & {
    viewport: CliOptions["viewport"];
  } = {
    breamerServiceUrl: process.env.BREAMER_ROOT_URL ?? DEFAULT_BREAMER_URL,
    extraWaitMs: 1000,
    fullPage: false,
    outputDir: "render-comparisons",
    viewport: {
      width: 1470,
      height: 956,
      deviceScaleFactor: 2,
      isMobile: false,
    },
    waitTimeoutMs: 60_000,
    waitUntil: "networkidle2",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
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
      case "--service-url": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.breamerServiceUrl = value;
        index = nextIndex;
        break;
      }
      case "--reference-http": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.referenceHttpUrl = value;
        index = nextIndex;
        break;
      }
      case "--reference-ws": {
        const { value, nextIndex } = takeValue(argv, index, arg);
        options.referenceWsEndpoint = value;
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
      case "--full-page":
        options.fullPage = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.accessToken ??= process.env.BREAMER_ACCESS_TOKEN;

  if (!options.targetUrl) {
    throw new Error("Missing page URL. Pass --url <url>.");
  }

  if (!options.accessToken) {
    throw new Error("Missing access token. Pass --token <token>.");
  }

  if (!options.referenceWsEndpoint && !options.referenceHttpUrl) {
    throw new Error("Pass --reference-ws or --reference-http for Mac Chrome.");
  }

  return {
    accessToken: options.accessToken,
    breamerServiceUrl: normalizeRootUrl(
      options.breamerServiceUrl ?? DEFAULT_BREAMER_URL,
    ),
    extraWaitMs: options.extraWaitMs ?? 1000,
    fullPage: options.fullPage ?? false,
    outputDir: options.outputDir ?? "render-comparisons",
    ...(options.referenceHttpUrl
      ? { referenceHttpUrl: normalizeRootUrl(options.referenceHttpUrl) }
      : {}),
    ...(options.referenceWsEndpoint
      ? { referenceWsEndpoint: options.referenceWsEndpoint }
      : {}),
    targetUrl: new URL(options.targetUrl).toString(),
    viewport: options.viewport,
    ...(options.waitForSelector
      ? { waitForSelector: options.waitForSelector }
      : {}),
    waitTimeoutMs: options.waitTimeoutMs ?? 60_000,
    waitUntil: options.waitUntil ?? "networkidle2",
  };
};

const requestBreamerSession = async (
  options: CliOptions,
): Promise<CdpSessionResponse> => {
  const response = await fetch(buildCdpUrl(options.breamerServiceUrl), {
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

const resolveReferenceWsEndpoint = async (
  options: CliOptions,
): Promise<string> => {
  if (options.referenceWsEndpoint) {
    return options.referenceWsEndpoint;
  }

  if (!options.referenceHttpUrl) {
    throw new Error("Missing reference Chrome endpoint.");
  }

  const response = await fetch(`${options.referenceHttpUrl}/json/version`);
  if (!response.ok) {
    throw new Error(
      `Failed to read reference Chrome metadata: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string") {
    throw new Error("Reference Chrome metadata did not include WebSocket URL.");
  }

  return body.webSocketDebuggerUrl;
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

const capturePage = async (
  browser: Browser,
  options: CliOptions,
): Promise<CaptureResult> => {
  const page = await browser.newPage();

  try {
    await page.setViewport(options.viewport);
    await page.goto(options.targetUrl, {
      timeout: options.waitTimeoutMs,
      waitUntil: options.waitUntil,
    });

    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, {
        timeout: options.waitTimeoutMs,
      });
    }

    if (options.extraWaitMs > 0) {
      await delay(options.extraWaitMs);
    }

    await Promise.race([
      page.evaluate(() => document.fonts?.ready ?? Promise.resolve()),
      delay(Math.min(options.waitTimeoutMs, 5000)),
    ]);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        }),
    );

    const [fingerprint, title, screenshot] = await Promise.all([
      readBrowserFingerprint(page),
      page.title(),
      page.screenshot({
        fullPage: options.fullPage,
        type: "png",
      }) as Promise<Uint8Array>,
    ]);

    return {
      finalUrl: page.url(),
      fingerprint,
      screenshot,
      title,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
};

const dataUrlFromPng = (png: Uint8Array): string => {
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
};

const compareScreenshots = async (
  browser: Browser,
  referencePng: Uint8Array,
  breamerPng: Uint8Array,
): Promise<PixelDiff> => {
  const page = await browser.newPage();

  try {
    return await page.evaluate(
      async (referenceDataUrl, breamerDataUrl): Promise<PixelDiff> => {
        const loadImage = (url: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("Failed to decode image"));
            image.src = url;
          });
        const draw = (image: HTMLImageElement) => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("Could not create 2D canvas context");
          }

          context.drawImage(image, 0, 0);
          return {
            height: canvas.height,
            pixels: context.getImageData(0, 0, canvas.width, canvas.height)
              .data,
            width: canvas.width,
          };
        };

        const [referenceImage, breamerImage] = await Promise.all([
          loadImage(referenceDataUrl),
          loadImage(breamerDataUrl),
        ]);
        const reference = draw(referenceImage);
        const breamer = draw(breamerImage);
        const width = Math.min(reference.width, breamer.width);
        const height = Math.min(reference.height, breamer.height);
        const comparedPixels = width * height;
        const threshold = 16;
        let exactMatches = 0;
        let maxChannelDelta = 0;
        let pixelsOverThreshold = 0;
        let sumAbsoluteChannelDelta = 0;
        let sumSquaredChannelDelta = 0;

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const referenceIndex = (y * reference.width + x) * 4;
            const breamerIndex = (y * breamer.width + x) * 4;
            let pixelExact = true;
            let pixelOverThreshold = false;

            for (let channel = 0; channel < 4; channel++) {
              const delta = Math.abs(
                reference.pixels[referenceIndex + channel] -
                  breamer.pixels[breamerIndex + channel],
              );
              sumAbsoluteChannelDelta += delta;
              sumSquaredChannelDelta += delta * delta;
              maxChannelDelta = Math.max(maxChannelDelta, delta);
              if (delta !== 0) {
                pixelExact = false;
              }
              if (delta > threshold) {
                pixelOverThreshold = true;
              }
            }

            if (pixelExact) {
              exactMatches++;
            }
            if (pixelOverThreshold) {
              pixelsOverThreshold++;
            }
          }
        }

        const channelCount = comparedPixels * 4;
        return {
          comparedPixels,
          dimensions: {
            breamer: {
              width: breamer.width,
              height: breamer.height,
            },
            reference: {
              width: reference.width,
              height: reference.height,
            },
          },
          exactPixelMatchRate:
            comparedPixels === 0 ? 0 : exactMatches / comparedPixels,
          maxChannelDelta,
          meanAbsoluteChannelDelta:
            channelCount === 0 ? 0 : sumAbsoluteChannelDelta / channelCount,
          pixelsOverThreshold,
          pixelsOverThresholdRate:
            comparedPixels === 0 ? 0 : pixelsOverThreshold / comparedPixels,
          rmsChannelDelta:
            channelCount === 0
              ? 0
              : Math.sqrt(sumSquaredChannelDelta / channelCount),
          threshold,
        };
      },
      dataUrlFromPng(referencePng),
      dataUrlFromPng(breamerPng),
    );
  } finally {
    await page.close().catch(() => undefined);
  }
};

const collectFingerprintDiffs = (
  reference: unknown,
  breamer: unknown,
  prefix = "",
): Array<{ path: string; reference: unknown; breamer: unknown }> => {
  if (
    typeof reference !== "object" ||
    reference === null ||
    typeof breamer !== "object" ||
    breamer === null
  ) {
    return Object.is(reference, breamer)
      ? []
      : [{ path: prefix || "$", reference, breamer }];
  }

  const keys = new Set([
    ...Object.keys(reference as Record<string, unknown>),
    ...Object.keys(breamer as Record<string, unknown>),
  ]);
  const diffs: Array<{ path: string; reference: unknown; breamer: unknown }> =
    [];

  for (const key of [...keys].sort()) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    diffs.push(
      ...collectFingerprintDiffs(
        (reference as Record<string, unknown>)[key],
        (breamer as Record<string, unknown>)[key],
        nextPath,
      ),
    );
  }

  return diffs;
};

const compareRendering = async (options: CliOptions): Promise<void> => {
  let breamerBrowser: Browser | undefined;
  let referenceBrowser: Browser | undefined;
  let shutdownUrl: string | undefined;

  try {
    const [breamerSession, referenceWsEndpoint] = await Promise.all([
      requestBreamerSession(options),
      resolveReferenceWsEndpoint(options),
    ]);
    shutdownUrl = breamerSession.shutdownUrl;

    [breamerBrowser, referenceBrowser] = await Promise.all([
      puppeteer.connect({
        browserWSEndpoint: breamerSession.wsEndpoint,
        defaultViewport: null,
      }),
      puppeteer.connect({
        browserWSEndpoint: referenceWsEndpoint,
        defaultViewport: null,
      }),
    ]);

    const [breamer, reference] = await Promise.all([
      capturePage(breamerBrowser, options),
      capturePage(referenceBrowser, options),
    ]);
    const pixelDiff = await compareScreenshots(
      referenceBrowser,
      reference.screenshot,
      breamer.screenshot,
    );
    const fingerprintDiffs = collectFingerprintDiffs(
      reference.fingerprint,
      breamer.fingerprint,
    );
    const basePath = artifactBasePath(options.targetUrl, options.outputDir);
    await mkdir(path.dirname(basePath), { recursive: true });

    const files = {
      breamerScreenshot: `${basePath}.breamer.png`,
      referenceScreenshot: `${basePath}.reference.png`,
      report: `${basePath}.report.json`,
    };
    await Promise.all([
      Bun.write(files.breamerScreenshot, breamer.screenshot),
      Bun.write(files.referenceScreenshot, reference.screenshot),
      Bun.write(
        files.report,
        JSON.stringify(
          {
            files,
            fingerprintDiffs,
            inputs: {
              fullPage: options.fullPage,
              targetUrl: options.targetUrl,
              viewport: options.viewport,
              waitUntil: options.waitUntil,
            },
            pixelDiff,
            results: {
              breamer: {
                finalUrl: breamer.finalUrl,
                fingerprint: breamer.fingerprint,
                title: breamer.title,
              },
              reference: {
                finalUrl: reference.finalUrl,
                fingerprint: reference.fingerprint,
                title: reference.title,
              },
            },
          },
          null,
          2,
        ),
      ),
    ]);

    console.log(
      JSON.stringify(
        {
          files,
          fingerprintDiffCount: fingerprintDiffs.length,
          firstFingerprintDiffs: fingerprintDiffs.slice(0, 20),
          pixelDiff,
        },
        null,
        2,
      ),
    );
  } finally {
    breamerBrowser?.disconnect();
    referenceBrowser?.disconnect();

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
  await compareRendering(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage);
  process.exit(1);
}
