import { WebSocket } from "ws";

interface PendingFrame {
  data: WebSocket.RawData;
  isBinary: boolean;
}

interface CdpMessage {
  error?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  sessionId?: unknown;
}

interface InternalCommand {
  resolve: (message: CdpMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ArchiveSettleDetails {
  status: "completed" | "failed" | "timeout";
  durationMs: number;
  sessionId?: string;
  error?: string;
  result?: unknown;
}

interface CdpRenderingDefaultsDetails {
  status: "completed" | "failed" | "timeout";
  durationMs: number;
  reason: "page-attached" | "client-command";
  sessionId: string;
  error?: string;
}

export interface CdpRenderingDefaults {
  acceptLanguage: string;
  colorGamut: "srgb" | "p3" | "rec2020";
  deviceMemoryGb: number;
  deviceScaleFactor: number;
  hardwareConcurrency: number;
  height: number;
  languages: string[];
  platform: string;
  prefersColorScheme: "light" | "dark";
  prefersReducedMotion: "no-preference" | "reduce";
  timezone?: string;
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
  width: number;
}

export interface PipeWebSocketOptions {
  onUpstreamError?: (err: Error) => void;
  onArchiveSettle?: (details: ArchiveSettleDetails) => void;
  onRenderingDefaults?: (details: CdpRenderingDefaultsDetails) => void;
  archiveSettleTimeoutMs?: number;
  autoScrollBeforeCaptureSnapshot?: boolean;
  rasterizeDynamicMediaBeforeCapture?: boolean;
  renderingDefaults?: CdpRenderingDefaults;
  renderingDefaultsTimeoutMs?: number;
  settleBeforeCaptureSnapshot?: boolean;
}

const sendFrame = (
  socket: WebSocket,
  data: WebSocket.RawData | string,
  isBinary: boolean,
): void => {
  socket.send(data, { binary: isBinary });
};

const textFromFrame = (data: WebSocket.RawData): string => {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  return Buffer.from(new Uint8Array(data)).toString("utf8");
};

const parseTextCdpMessage = (
  data: WebSocket.RawData,
  isBinary: boolean,
): CdpMessage | undefined => {
  if (isBinary) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(textFromFrame(data)) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as CdpMessage;
    }
  } catch (error) {
    void error;
    return undefined;
  }

  return undefined;
};

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const cdpIdKey = (id: unknown): string | undefined => {
  if (typeof id === "number" || typeof id === "string") {
    return String(id);
  }

  return undefined;
};

export const buildArchiveSettleExpression = (
  timeoutMs: number,
  autoScrollBeforeCapture: boolean,
  rasterizeDynamicMedia: boolean,
): string => {
  return `(${String(
    async (
      maxWaitMs: number,
      shouldAutoScrollBeforeCapture: boolean,
      shouldRasterizeDynamicMedia: boolean,
    ) => {
      const startedAt = performance.now();
      const remainingMs = () =>
        Math.max(0, maxWaitMs - (performance.now() - startedAt));
      const delay = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const nextFrame = () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => resolve(undefined)),
        );
      const waitForIdle = () =>
        new Promise((resolve) => {
          if ("requestIdleCallback" in window) {
            window.requestIdleCallback(() => resolve(undefined), {
              timeout: 500,
            });
            return;
          }

          setTimeout(resolve, 100);
        });
      const collectElements = () => {
        const elements: Element[] = [];
        const visit = (root: ParentNode) => {
          for (const element of Array.from(root.querySelectorAll("*"))) {
            elements.push(element);
            const shadowRoot = (element as HTMLElement).shadowRoot;
            if (shadowRoot) {
              visit(shadowRoot);
            }
          }
        };

        visit(document);
        return elements;
      };
      const collectImages = () =>
        collectElements().filter(
          (element): element is HTMLImageElement =>
            element instanceof HTMLImageElement,
        );
      const prepareImageForCapture = (image: HTMLImageElement) => {
        image.loading = "eager";
        image.decoding = "async";
        (image as HTMLImageElement & { fetchPriority?: string }).fetchPriority =
          "high";
      };
      const waitForImage = (image: HTMLImageElement) => {
        prepareImageForCapture(image);

        if (image.complete) {
          return Promise.resolve();
        }

        if (typeof image.decode === "function") {
          return image.decode().catch(() => undefined);
        }

        return new Promise((resolve) => {
          image.addEventListener("load", () => resolve(undefined), {
            once: true,
          });
          image.addEventListener("error", () => resolve(undefined), {
            once: true,
          });
        });
      };
      const collectCssImageUrls = () => {
        const urls = new Set<string>();
        const addUrls = (value: string) => {
          for (const match of value.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
            const url = match[2]?.trim();
            if (url && url !== "none") {
              urls.add(url);
            }
          }
        };
        const addStyleUrls = (style: CSSStyleDeclaration) => {
          addUrls(style.backgroundImage);
          addUrls(style.borderImageSource);
          addUrls(style.listStyleImage);
          addUrls(style.getPropertyValue("mask-image"));
          addUrls(style.getPropertyValue("-webkit-mask-image"));
        };

        for (const element of collectElements()) {
          addStyleUrls(getComputedStyle(element));
          addStyleUrls(getComputedStyle(element, "::before"));
          addStyleUrls(getComputedStyle(element, "::after"));
        }

        return Array.from(urls);
      };
      const waitForCssImage = (url: string) => {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        return waitForImage(image);
      };
      const waitForDomReady = () => {
        if (document.readyState !== "loading") {
          return Promise.resolve();
        }

        return new Promise((resolve) => {
          document.addEventListener(
            "DOMContentLoaded",
            () => resolve(undefined),
            {
              once: true,
            },
          );
        });
      };
      const loadLazyContent = async () => {
        if (!shouldAutoScrollBeforeCapture) {
          return { containers: 0, scrolled: false, steps: 0 };
        }

        const originalX = scrollX;
        const originalY = scrollY;
        const maxScrollY = Math.max(
          document.body?.scrollHeight ?? 0,
          document.documentElement?.scrollHeight ?? 0,
          document.scrollingElement?.scrollHeight ?? 0,
          innerHeight,
        );

        const step = Math.max(256, Math.floor(innerHeight * 0.85));
        const deadline =
          performance.now() +
          Math.min(1200, Math.max(250, remainingMs() * 0.45));
        let nextY = originalY;
        let steps = 0;
        let containers = 0;

        const scrollContainer = async (element: HTMLElement) => {
          const originalTop = element.scrollTop;
          const maxTop = element.scrollHeight - element.clientHeight;
          const containerStep = Math.max(
            128,
            Math.floor(element.clientHeight * 0.85),
          );
          let nextTop = originalTop;

          try {
            while (nextTop < maxTop && performance.now() < deadline) {
              nextTop = Math.min(maxTop, nextTop + containerStep);
              element.scrollTop = nextTop;
              steps++;
              await nextFrame();
              await delay(40);
            }
          } finally {
            element.scrollTop = originalTop;
            await nextFrame();
          }
        };

        try {
          while (
            maxScrollY > innerHeight + 1 &&
            nextY < maxScrollY &&
            performance.now() < deadline
          ) {
            nextY = Math.min(maxScrollY, nextY + step);
            scrollTo(originalX, nextY);
            steps++;
            await nextFrame();
            await delay(50);
          }

          for (const element of collectElements().filter(
            (element): element is HTMLElement =>
              element instanceof HTMLElement &&
              element !== document.body &&
              element !== document.documentElement,
          )) {
            if (performance.now() >= deadline || containers >= 25) {
              break;
            }

            const style = getComputedStyle(element);
            const canScrollY =
              element.scrollHeight > element.clientHeight + 1 &&
              /auto|scroll|overlay/.test(style.overflowY);
            if (!canScrollY) {
              continue;
            }

            containers++;
            await scrollContainer(element);
          }
        } finally {
          scrollTo(originalX, originalY);
          await nextFrame();
        }

        return { containers, scrolled: steps > 0, steps };
      };
      const copyVisualIdentity = (
        source: HTMLElement,
        image: HTMLImageElement,
        kind: string,
      ) => {
        const rect = source.getBoundingClientRect();
        const style = getComputedStyle(source);

        image.id = source.id;
        image.className = source.className;
        image.alt =
          source.getAttribute("aria-label") ??
          source.getAttribute("title") ??
          kind;
        image.setAttribute("data-breamer-rasterized", kind);
        image.style.cssText = source.getAttribute("style") ?? "";
        image.style.display =
          style.display === "inline" ? "inline-block" : style.display;
        image.style.width = `${Math.max(1, Math.round(rect.width))}px`;
        image.style.height = `${Math.max(1, Math.round(rect.height))}px`;
        image.style.objectFit = style.objectFit;
        image.style.objectPosition = style.objectPosition;
        image.style.verticalAlign = style.verticalAlign;
      };
      const rasterizeDynamicMedia = () => {
        if (!shouldRasterizeDynamicMedia) {
          return { canvases: 0, videos: 0 };
        }

        let canvases = 0;
        let videos = 0;

        for (const canvas of collectElements().filter(
          (element): element is HTMLCanvasElement =>
            element instanceof HTMLCanvasElement,
        )) {
          try {
            if (canvas.width <= 0 || canvas.height <= 0) {
              continue;
            }

            const image = new Image();
            image.src = canvas.toDataURL("image/png");
            image.width = canvas.clientWidth || canvas.width;
            image.height = canvas.clientHeight || canvas.height;
            copyVisualIdentity(canvas, image, "canvas");
            canvas.replaceWith(image);
            canvases++;
          } catch (error) {
            void error;
          }
        }

        for (const video of collectElements().filter(
          (element): element is HTMLVideoElement =>
            element instanceof HTMLVideoElement,
        )) {
          try {
            if (video.videoWidth <= 0 || video.videoHeight <= 0) {
              continue;
            }

            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d")?.drawImage(video, 0, 0);

            const image = new Image();
            image.src = canvas.toDataURL("image/png");
            image.width = video.clientWidth || video.videoWidth;
            image.height = video.clientHeight || video.videoHeight;
            copyVisualIdentity(video, image, "video");
            video.replaceWith(image);
            videos++;
          } catch (error) {
            void error;
          }
        }

        return { canvases, videos };
      };
      const readBlobAsDataUrl = (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(String(reader.result)));
          reader.addEventListener("error", () =>
            reject(reader.error ?? new Error("Failed to read font blob")),
          );
          reader.readAsDataURL(blob);
        });
      const collectFontFaceBlocks = (cssText: string, baseUrl: string) => {
        const blocks: Array<{ baseUrl: string; cssText: string }> = [];

        for (const match of cssText.matchAll(/@font-face\s*{[^}]*}/gi)) {
          if (match[0]) {
            blocks.push({ baseUrl, cssText: match[0] });
          }
        }

        return blocks;
      };
      const inlineFontFaces = async () => {
        const result = {
          bytes: 0,
          failed: 0,
          fontFaceCount: 0,
          inlined: 0,
          styleSheetCount: 0,
        };
        const maxFontBytes = 12 * 1024 * 1024;
        const maxTotalBytes = 48 * 1024 * 1024;
        const fontCache = new Map<string, Promise<string | undefined>>();
        const fontFaceBlocks: Array<{ baseUrl: string; cssText: string }> = [];
        const withRemainingDeadline = async <T>(
          promise: Promise<T>,
        ): Promise<T | undefined> => {
          const timeout = Math.max(1, remainingMs() - 50);
          if (timeout < 100) {
            return undefined;
          }

          return await Promise.race([
            promise,
            delay(timeout).then(() => undefined),
          ]);
        };

        const readStyleSheet = async (styleSheet: CSSStyleSheet) => {
          const baseUrl = styleSheet.href ?? document.baseURI;

          try {
            const cssText = Array.from(styleSheet.cssRules)
              .map((rule) => rule.cssText)
              .join("\n");
            fontFaceBlocks.push(...collectFontFaceBlocks(cssText, baseUrl));
            return;
          } catch (error) {
            void error;
          }

          if (!styleSheet.href || remainingMs() < 150) {
            return;
          }

          try {
            const response = await withRemainingDeadline(
              fetch(styleSheet.href, {
                cache: "force-cache",
                credentials: "include",
              }),
            );
            if (!response?.ok) {
              result.failed++;
              return;
            }

            const cssText = await withRemainingDeadline(response.text());
            if (!cssText) {
              result.failed++;
              return;
            }

            fontFaceBlocks.push(...collectFontFaceBlocks(cssText, baseUrl));
          } catch (error) {
            void error;
            result.failed++;
          }
        };

        for (const styleSheet of Array.from(document.styleSheets)) {
          if (remainingMs() < 150) {
            break;
          }

          result.styleSheetCount++;
          await readStyleSheet(styleSheet);
        }

        result.fontFaceCount = fontFaceBlocks.length;

        const fetchFontAsDataUrl = (
          rawUrl: string,
          baseUrl: string,
        ): Promise<string | undefined> => {
          const trimmed = rawUrl.trim();
          if (/^(?:data:|blob:|about:|#)/i.test(trimmed)) {
            return Promise.resolve(trimmed);
          }

          let href: string;
          try {
            href = new URL(trimmed, baseUrl).href;
          } catch (error) {
            void error;
            result.failed++;
            return Promise.resolve(undefined);
          }

          const cached = fontCache.get(href);
          if (cached) {
            return cached;
          }

          const promise = (async () => {
            if (remainingMs() < 150 || result.bytes >= maxTotalBytes) {
              return undefined;
            }

            try {
              const response = await withRemainingDeadline(
                fetch(href, {
                  cache: "force-cache",
                  credentials: "include",
                }),
              );
              if (!response?.ok) {
                result.failed++;
                return undefined;
              }

              const blob = await withRemainingDeadline(response.blob());
              if (!blob) {
                result.failed++;
                return undefined;
              }

              if (
                blob.size <= 0 ||
                blob.size > maxFontBytes ||
                result.bytes + blob.size > maxTotalBytes
              ) {
                result.failed++;
                return undefined;
              }

              result.bytes += blob.size;
              const dataUrl = await withRemainingDeadline(
                readBlobAsDataUrl(blob),
              );
              if (!dataUrl) {
                result.failed++;
              }
              return dataUrl;
            } catch (error) {
              void error;
              result.failed++;
              return undefined;
            }
          })();

          fontCache.set(href, promise);
          return promise;
        };

        const inlineUrlsInCss = async (
          cssText: string,
          baseUrl: string,
        ): Promise<string | undefined> => {
          const pieces: string[] = [];
          let cursor = 0;
          let changed = false;

          for (const match of cssText.matchAll(
            /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
          )) {
            if (typeof match.index !== "number") {
              continue;
            }

            pieces.push(cssText.slice(cursor, match.index));
            const dataUrl = await fetchFontAsDataUrl(match[2] ?? "", baseUrl);
            if (dataUrl) {
              pieces.push(`url("${dataUrl}")`);
              changed = true;
              result.inlined++;
            } else {
              pieces.push(match[0] ?? "");
            }
            cursor = match.index + (match[0]?.length ?? 0);
          }

          if (!changed) {
            return undefined;
          }

          pieces.push(cssText.slice(cursor));
          return pieces.join("");
        };

        const inlinedRules = (
          await Promise.all(
            fontFaceBlocks.map((block) =>
              remainingMs() < 150
                ? Promise.resolve(undefined)
                : inlineUrlsInCss(block.cssText, block.baseUrl),
            ),
          )
        ).filter((rule): rule is string => typeof rule === "string");

        if (inlinedRules.length > 0) {
          const style = document.createElement("style");
          style.setAttribute("data-breamer-fonts-inlined", "true");
          style.textContent = inlinedRules.join("\n");
          document.head.appendChild(style);
          document.body?.getBoundingClientRect();

          await Promise.race([
            document.fonts?.ready ?? Promise.resolve(),
            delay(Math.min(1000, Math.max(1, remainingMs()))),
          ]);
        }

        return result;
      };

      const initialFontsReady = document.fonts?.ready ?? Promise.resolve();
      const lateLayoutFloor = delay(250);

      await Promise.race([
        Promise.allSettled([
          waitForDomReady(),
          initialFontsReady,
          lateLayoutFloor,
        ]),
        delay(Math.min(maxWaitMs, Math.max(100, maxWaitMs * 0.4))),
      ]);

      const fonts = await inlineFontFaces();
      const fontsReady = document.fonts?.ready ?? Promise.resolve();
      const lazyScroll = await loadLazyContent();
      const cssImageUrls = collectCssImageUrls();
      const imagesReady = Promise.allSettled(collectImages().map(waitForImage));
      const cssImagesReady = Promise.allSettled(
        cssImageUrls.map(waitForCssImage),
      );

      await Promise.race([
        Promise.allSettled([fontsReady, imagesReady, cssImagesReady]),
        delay(Math.max(1, remainingMs())),
      ]);

      const rasterized = rasterizeDynamicMedia();
      await nextFrame();
      await nextFrame();
      await waitForIdle();
      await nextFrame();

      return {
        href: location.href,
        readyState: document.readyState,
        cssImageCount: cssImageUrls.length,
        imageCount: collectImages().length,
        fonts,
        lazyScroll,
        rasterized,
      };
    },
  )})(${JSON.stringify(timeoutMs)}, ${JSON.stringify(
    autoScrollBeforeCapture,
  )}, ${JSON.stringify(rasterizeDynamicMedia)})`;
};

const buildNavigatorOverrideSource = (
  deviceMemoryGb: number,
  hardwareConcurrency: number,
  height: number,
  platform: string,
  languages: string[],
  width: number,
): string => {
  return `(${String(
    (
      nextDeviceMemoryGb: number,
      nextHardwareConcurrency: number,
      nextHeight: number,
      nextPlatform: string,
      nextLanguages: string[],
      nextWidth: number,
    ) => {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => nextLanguages[0],
      });
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        get: () => nextPlatform,
      });
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => nextLanguages,
      });
      Object.defineProperty(navigator, "webdriver", {
        configurable: true,
        get: () => undefined,
      });
      Object.defineProperty(navigator, "hardwareConcurrency", {
        configurable: true,
        get: () => nextHardwareConcurrency,
      });
      Object.defineProperty(navigator, "deviceMemory", {
        configurable: true,
        get: () => nextDeviceMemoryGb,
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
        get: () => nextWidth,
      });
      Object.defineProperty(screen, "height", {
        configurable: true,
        get: () => nextHeight,
      });
      Object.defineProperty(screen, "availWidth", {
        configurable: true,
        get: () => nextWidth,
      });
      Object.defineProperty(screen, "availHeight", {
        configurable: true,
        get: () => nextHeight,
      });
    },
  )})(${JSON.stringify(deviceMemoryGb)}, ${JSON.stringify(
    hardwareConcurrency,
  )}, ${JSON.stringify(height)}, ${JSON.stringify(platform)}, ${JSON.stringify(
    languages,
  )}, ${JSON.stringify(width)})`;
};

const shouldSettleBeforeCaptureSnapshot = (
  message: CdpMessage | undefined,
  enabled: boolean,
): message is CdpMessage & { id: number | string } => {
  return (
    enabled &&
    message?.method === "Page.captureSnapshot" &&
    (typeof message.id === "number" || typeof message.id === "string")
  );
};

const cdpParams = (
  message: CdpMessage | undefined,
): Record<string, unknown> => {
  if (typeof message?.params === "object" && message.params !== null) {
    return message.params as Record<string, unknown>;
  }

  return {};
};

const targetInfoFromParams = (
  params: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const targetInfo = params.targetInfo;
  if (typeof targetInfo === "object" && targetInfo !== null) {
    return targetInfo as Record<string, unknown>;
  }
};

export const pipeWebSockets = (
  client: WebSocket,
  upstream: WebSocket,
  options: PipeWebSocketOptions = {},
): void => {
  const pending: PendingFrame[] = [];
  const internalCommands = new Map<string, InternalCommand>();
  const defaultedPageSessionIds = new Set<string>();
  const defaultingPageSessionIds = new Map<string, Promise<void>>();
  const pageSessionIds = new Set<string>();
  const suppressedInternalIds = new Set<string>();
  const settleBeforeCaptureSnapshot =
    options.settleBeforeCaptureSnapshot ?? true;
  const autoScrollBeforeCaptureSnapshot =
    options.autoScrollBeforeCaptureSnapshot ?? true;
  const rasterizeDynamicMediaBeforeCapture =
    options.rasterizeDynamicMediaBeforeCapture ?? true;
  const archiveSettleTimeoutMs = Math.max(
    1,
    options.archiveSettleTimeoutMs ?? 10000,
  );
  const renderingDefaultsTimeoutMs = Math.max(
    1,
    options.renderingDefaultsTimeoutMs ?? 1500,
  );
  let nextInternalId = -1;
  let clientFrameQueue = Promise.resolve();

  const rejectInternalCommands = (error: Error): void => {
    for (const [id, command] of internalCommands) {
      clearTimeout(command.timeout);
      command.reject(error);
      suppressedInternalIds.add(id);
    }
    internalCommands.clear();
  };

  const sendInternalCommand = (
    command: Omit<CdpMessage, "id">,
    timeoutMs: number,
  ): Promise<CdpMessage> => {
    if (upstream.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP upstream is not open"));
    }

    const id = nextInternalId--;
    const key = String(id);
    const responseTimeoutMs =
      timeoutMs + Math.min(250, Math.max(25, Math.floor(timeoutMs * 0.2)));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        internalCommands.delete(key);
        suppressedInternalIds.add(key);
        reject(new Error(`timed out after ${responseTimeoutMs}ms`));
      }, responseTimeoutMs);

      internalCommands.set(key, { resolve, reject, timeout });
      sendFrame(
        upstream,
        JSON.stringify({
          ...command,
          id,
        }),
        false,
      );
    });
  };

  const settlePageForArchive = async (message: CdpMessage): Promise<void> => {
    const sessionId =
      typeof message.sessionId === "string" ? message.sessionId : undefined;
    const startedAt = performance.now();

    try {
      const response = await sendInternalCommand(
        {
          ...(sessionId ? { sessionId } : {}),
          method: "Runtime.evaluate",
          params: {
            expression: buildArchiveSettleExpression(
              archiveSettleTimeoutMs,
              autoScrollBeforeCaptureSnapshot,
              rasterizeDynamicMediaBeforeCapture,
            ),
            awaitPromise: true,
            returnByValue: true,
          },
        },
        archiveSettleTimeoutMs,
      );

      if ("error" in response) {
        const error = response.error as { message?: unknown };
        throw new Error(String(error.message ?? "Runtime.evaluate failed"));
      }

      const responseResult = response.result as
        | { result?: { value?: unknown } }
        | undefined;

      options.onArchiveSettle?.({
        status: "completed",
        durationMs: Math.round(performance.now() - startedAt),
        ...(sessionId ? { sessionId } : {}),
        result: responseResult?.result?.value,
      });
    } catch (error) {
      const messageText = describeError(error);
      options.onArchiveSettle?.({
        status: messageText.startsWith("timed out") ? "timeout" : "failed",
        durationMs: Math.round(performance.now() - startedAt),
        ...(sessionId ? { sessionId } : {}),
        error: messageText,
      });
    }
  };

  const sendRenderingDefaultCommands = (
    sessionId: string,
    defaults: CdpRenderingDefaults,
  ): Array<Promise<CdpMessage>> => {
    const withSession = (command: Omit<CdpMessage, "id" | "sessionId">) =>
      sendInternalCommand(
        {
          ...command,
          sessionId,
        },
        renderingDefaultsTimeoutMs,
      );

    const commands = [
      withSession({
        method: "Network.setUserAgentOverride",
        params: {
          acceptLanguage: defaults.acceptLanguage,
          platform: defaults.platform,
          userAgent: defaults.userAgent,
          userAgentMetadata: defaults.userAgentMetadata,
        },
      }),
      withSession({
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          deviceScaleFactor: defaults.deviceScaleFactor,
          height: defaults.height,
          mobile: false,
          positionX: 0,
          positionY: 0,
          screenHeight: defaults.height,
          screenOrientation: {
            angle: 0,
            type: "landscapePrimary",
          },
          screenWidth: defaults.width,
          width: defaults.width,
        },
      }),
      withSession({
        method: "Emulation.setTouchEmulationEnabled",
        params: {
          enabled: false,
          maxTouchPoints: 0,
        },
      }),
      withSession({
        method: "Emulation.setLocaleOverride",
        params: {
          locale: defaults.languages[0] ?? "en-US",
        },
      }),
      withSession({
        method: "Emulation.setEmulatedMedia",
        params: {
          features: [
            { name: "color-gamut", value: defaults.colorGamut },
            {
              name: "prefers-color-scheme",
              value: defaults.prefersColorScheme,
            },
            {
              name: "prefers-reduced-motion",
              value: defaults.prefersReducedMotion,
            },
          ],
          media: "screen",
        },
      }),
      withSession({
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
      }),
      withSession({
        method: "Emulation.setIdleOverride",
        params: {
          isScreenUnlocked: true,
          isUserActive: true,
        },
      }),
      withSession({
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: {
          source: buildNavigatorOverrideSource(
            defaults.deviceMemoryGb,
            defaults.hardwareConcurrency,
            defaults.height,
            defaults.platform,
            defaults.languages,
            defaults.width,
          ),
        },
      }),
    ];

    if (defaults.timezone) {
      commands.push(
        withSession({
          method: "Emulation.setTimezoneOverride",
          params: { timezoneId: defaults.timezone },
        }),
      );
    }

    return commands;
  };

  const applyRenderingDefaultsOnce = async (
    sessionId: string,
    reason: CdpRenderingDefaultsDetails["reason"],
  ): Promise<void> => {
    const defaults = options.renderingDefaults;
    if (!defaults || defaultedPageSessionIds.has(sessionId)) {
      return;
    }

    const inFlight = defaultingPageSessionIds.get(sessionId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const promise = applyRenderingDefaults(sessionId, reason, defaults).finally(
      () => {
        defaultingPageSessionIds.delete(sessionId);
      },
    );
    defaultingPageSessionIds.set(sessionId, promise);
    await promise;
  };

  const applyRenderingDefaults = async (
    sessionId: string,
    reason: CdpRenderingDefaultsDetails["reason"],
    defaults: CdpRenderingDefaults,
  ): Promise<void> => {
    const startedAt = performance.now();
    const results = await Promise.allSettled(
      sendRenderingDefaultCommands(sessionId, defaults),
    );
    defaultedPageSessionIds.add(sessionId);

    const failed = results.find(
      (result) =>
        result.status === "rejected" ||
        (result.status === "fulfilled" && "error" in result.value),
    );

    if (!failed) {
      options.onRenderingDefaults?.({
        status: "completed",
        durationMs: Math.round(performance.now() - startedAt),
        reason,
        sessionId,
      });
      return;
    }

    const error =
      failed.status === "rejected"
        ? describeError(failed.reason)
        : String(
            (failed.value.error as { message?: unknown } | undefined)
              ?.message ?? "CDP rendering default command failed",
          );

    options.onRenderingDefaults?.({
      status: error.startsWith("timed out") ? "timeout" : "failed",
      durationMs: Math.round(performance.now() - startedAt),
      reason,
      sessionId,
      error,
    });
  };

  const clientPageSessionId = (
    message: CdpMessage | undefined,
  ): string | undefined => {
    if (typeof message?.sessionId !== "string") {
      return undefined;
    }

    if (pageSessionIds.has(message.sessionId)) {
      return message.sessionId;
    }
  };

  const forwardClientFrame = async (
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> => {
    if (upstream.readyState !== WebSocket.OPEN) {
      pending.push({ data, isBinary });
      return;
    }

    const message = parseTextCdpMessage(data, isBinary);
    const pageSessionId = clientPageSessionId(message);
    if (pageSessionId) {
      await applyRenderingDefaultsOnce(pageSessionId, "client-command");
    }

    if (
      shouldSettleBeforeCaptureSnapshot(message, settleBeforeCaptureSnapshot)
    ) {
      await settlePageForArchive(message);
    }

    if (upstream.readyState === WebSocket.OPEN) {
      sendFrame(upstream, data, isBinary);
    }
  };

  const enqueueClientFrame = (
    data: WebSocket.RawData,
    isBinary: boolean,
  ): void => {
    clientFrameQueue = clientFrameQueue
      .then(() => forwardClientFrame(data, isBinary))
      .catch((error) => {
        options.onUpstreamError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  };

  client.on("message", (data, isBinary) => {
    enqueueClientFrame(data, isBinary);
  });

  upstream.once("open", () => {
    for (const { data, isBinary } of pending) {
      enqueueClientFrame(data, isBinary);
    }
    pending.length = 0;
  });

  const handleUpstreamFrame = async (
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> => {
    const message = parseTextCdpMessage(data, isBinary);
    const key = cdpIdKey(message?.id);
    if (key) {
      const internalCommand = internalCommands.get(key);
      if (internalCommand) {
        internalCommands.delete(key);
        clearTimeout(internalCommand.timeout);
        internalCommand.resolve(message ?? {});
        return;
      }

      if (suppressedInternalIds.delete(key)) {
        return;
      }
    }

    if (message?.method === "Target.attachedToTarget") {
      const params = cdpParams(message);
      const targetInfo = targetInfoFromParams(params);
      if (typeof params.sessionId === "string" && targetInfo?.type === "page") {
        pageSessionIds.add(params.sessionId);
      }
    } else if (message?.method === "Target.detachedFromTarget") {
      const params = cdpParams(message);
      if (typeof params.sessionId === "string") {
        pageSessionIds.delete(params.sessionId);
        defaultedPageSessionIds.delete(params.sessionId);
        defaultingPageSessionIds.delete(params.sessionId);
      }
    }

    if (client.readyState === WebSocket.OPEN) {
      sendFrame(client, data, isBinary);
    }
  };

  upstream.on("message", (data, isBinary) => {
    handleUpstreamFrame(data, isBinary).catch((error) => {
      options.onUpstreamError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (client.readyState === WebSocket.OPEN) {
        sendFrame(client, data, isBinary);
      }
    });
  });

  upstream.on("close", (code, reason) => {
    rejectInternalCommands(new Error("CDP upstream closed"));
    if (client.readyState === WebSocket.OPEN) {
      client.close(code, reason);
    }
  });

  client.on("close", (code, reason) => {
    rejectInternalCommands(new Error("CDP client closed"));
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(code, reason);
    } else {
      upstream.terminate();
    }
  });

  upstream.on("error", (err) => {
    rejectInternalCommands(err);
    options.onUpstreamError?.(err);
    if (client.readyState === WebSocket.OPEN) {
      client.close(1011, "CDP upstream error");
    }
  });
};
