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

interface MhtmlFontEmbedOptions {
  maxFontBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
}

interface MhtmlFontEmbedResult {
  data: string;
  fonts: {
    bytes: number;
    discovered: number;
    embedded: number;
    failed: number;
    skippedExisting: number;
  };
}

const decodeQuotedPrintableForUrls = (value: string): string =>
  value
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

const extractExternalFontUrlsFromMhtml = (mhtml: string): string[] => {
  const decoded = decodeQuotedPrintableForUrls(mhtml);
  const urls = new Set<string>();

  for (const match of decoded.matchAll(
    /https?:\/\/[^\s"'()<>;\\]+?\.(?:otf|ttf|woff2?)(?:\?[^\s"'()<>;\\]*)?/gi,
  )) {
    const rawUrl = match[0]?.replace(/&amp;/g, "&");
    if (!rawUrl) {
      continue;
    }

    try {
      urls.add(new URL(rawUrl).toString());
    } catch (error) {
      void error;
    }
  }

  return Array.from(urls);
};

const findMhtmlBoundary = (mhtml: string): string | undefined => {
  const match = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(mhtml);
  return match?.[1] ?? match?.[2];
};

const fontContentType = (url: string): string => {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".woff2")) {
    return "font/woff2";
  }
  if (pathname.endsWith(".woff")) {
    return "font/woff";
  }
  if (pathname.endsWith(".ttf")) {
    return "font/ttf";
  }
  if (pathname.endsWith(".otf")) {
    return "font/otf";
  }
  return "application/octet-stream";
};

const wrapBase64 = (value: string): string =>
  value.match(/.{1,76}/g)?.join("\r\n") ?? value;

const hasMhtmlContentLocation = (mhtml: string, url: string): boolean => {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Content-Location:\\s*${escaped}\\s*$`, "im").test(mhtml);
};

const fetchFontForMhtml = async (
  url: string,
  timeoutMs: number,
): Promise<Uint8Array | undefined> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "font/woff2,font/woff,font/ttf,font/otf,*/*",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    void error;
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
};

export const embedExternalFontResourcesInMhtml = async (
  mhtml: string,
  options: MhtmlFontEmbedOptions = {},
): Promise<MhtmlFontEmbedResult> => {
  const boundary = findMhtmlBoundary(mhtml);
  const urls = extractExternalFontUrlsFromMhtml(mhtml);
  const maxFontBytes = options.maxFontBytes ?? 12 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fonts = {
    bytes: 0,
    discovered: urls.length,
    embedded: 0,
    failed: 0,
    skippedExisting: 0,
  };

  if (!boundary || urls.length === 0) {
    return { data: mhtml, fonts };
  }

  const delimiter = `--${boundary}`;
  const closingDelimiter = `${delimiter}--`;
  const closingIndex = mhtml.lastIndexOf(closingDelimiter);
  if (closingIndex === -1) {
    return { data: mhtml, fonts };
  }

  const candidates = urls.filter((url) => {
    if (!hasMhtmlContentLocation(mhtml, url)) {
      return true;
    }

    fonts.skippedExisting++;
    return false;
  });

  const fetched = await Promise.all(
    candidates.map(async (url) => ({
      bytes: await fetchFontForMhtml(url, timeoutMs),
      url,
    })),
  );

  const parts: string[] = [];
  for (const { bytes, url } of fetched) {
    if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > maxFontBytes) {
      fonts.failed++;
      continue;
    }
    if (fonts.bytes + bytes.byteLength > maxTotalBytes) {
      fonts.failed++;
      continue;
    }

    fonts.bytes += bytes.byteLength;
    fonts.embedded++;
    parts.push(
      [
        delimiter,
        `Content-Type: ${fontContentType(url)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Location: ${url}`,
        "",
        wrapBase64(Buffer.from(bytes).toString("base64")),
        "",
      ].join("\r\n"),
    );
  }

  if (parts.length === 0) {
    return { data: mhtml, fonts };
  }

  return {
    data: `${mhtml.slice(0, closingIndex)}${parts.join("")}${mhtml.slice(
      closingIndex,
    )}`,
    fonts,
  };
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
          externalStyleSheets: 0,
          failed: 0,
          fontFaceCount: 0,
          fontUrlCount: 0,
          inlined: 0,
          inlineStyleCount: 0,
          readBlockedStyleSheetCount: 0,
          styleSheetCount: 0,
        };
        const maxFontBytes = 12 * 1024 * 1024;
        const maxTotalBytes = 48 * 1024 * 1024;
        const fontCache = new Map<string, Promise<string | undefined>>();
        const fontFaceBlocks: Array<{ baseUrl: string; cssText: string }> = [];
        const fontFaceBlockKeys = new Set<string>();
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
        const addFontFaceBlocks = (cssText: string, baseUrl: string) => {
          for (const block of collectFontFaceBlocks(cssText, baseUrl)) {
            const key = `${block.baseUrl}\n${block.cssText}`;
            if (fontFaceBlockKeys.has(key)) {
              continue;
            }

            fontFaceBlockKeys.add(key);
            fontFaceBlocks.push(block);
          }
        };
        const readCssRules = (styleSheet: CSSStyleSheet): boolean => {
          const baseUrl = styleSheet.href ?? document.baseURI;

          try {
            const cssText = Array.from(styleSheet.cssRules)
              .map((rule) => rule.cssText)
              .join("\n");
            addFontFaceBlocks(cssText, baseUrl);
            return true;
          } catch (error) {
            void error;
            return false;
          }
        };
        const fetchStyleSheet = async (href: string) => {
          if (remainingMs() < 150) {
            return;
          }

          result.externalStyleSheets++;

          try {
            const response = await withRemainingDeadline(
              fetch(href, {
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

            addFontFaceBlocks(cssText, href);
          } catch (error) {
            void error;
            result.failed++;
          }
        };

        for (const styleElement of Array.from(
          document.querySelectorAll("style"),
        )) {
          const cssText = styleElement.textContent;
          if (!cssText) {
            continue;
          }

          result.inlineStyleCount++;
          addFontFaceBlocks(cssText, document.baseURI);
        }

        const blockedStyleSheetHrefs: string[] = [];
        for (const styleSheet of Array.from(document.styleSheets)) {
          result.styleSheetCount++;
          if (readCssRules(styleSheet)) {
            continue;
          }

          result.readBlockedStyleSheetCount++;
          if (styleSheet.href) {
            blockedStyleSheetHrefs.push(styleSheet.href);
          }
        }

        await Promise.race([
          Promise.allSettled(
            blockedStyleSheetHrefs.map((href) => fetchStyleSheet(href)),
          ),
          delay(Math.max(1, remainingMs())),
        ]);

        const performanceFontUrls =
          "getEntriesByType" in performance
            ? performance
                .getEntriesByType("resource")
                .filter(
                  (entry): entry is PerformanceResourceTiming =>
                    entry instanceof PerformanceResourceTiming &&
                    (entry.initiatorType === "font" ||
                      /\.(?:otf|ttf|woff2?)(?:[?#]|$)/i.test(entry.name)),
                )
                .map((entry) => entry.name)
            : [];

        if (
          performanceFontUrls.length > 0 &&
          fontFaceBlocks.length > 0 &&
          remainingMs() >= 150
        ) {
          const knownFontCssText = fontFaceBlocks
            .map((block) => block.cssText)
            .join("\n");
          for (const url of performanceFontUrls) {
            if (knownFontCssText.includes(url)) {
              continue;
            }

            const baseName = decodeURIComponent(
              url.split("/").pop()?.split("?")[0]?.split("#")[0] ?? "",
            );
            const matchingBlock = fontFaceBlocks.find((block) =>
              baseName ? block.cssText.includes(baseName) : false,
            );
            if (matchingBlock) {
              addFontFaceBlocks(matchingBlock.cssText, url);
            }
          }
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
              result.fontUrlCount++;
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
      const normalizeParserUnsafeParagraphs = () => {
        const paragraphBreakingTags = new Set([
          "ADDRESS",
          "ARTICLE",
          "ASIDE",
          "BLOCKQUOTE",
          "CENTER",
          "DD",
          "DETAILS",
          "DIALOG",
          "DIR",
          "DIV",
          "DL",
          "DT",
          "FIELDSET",
          "FIGCAPTION",
          "FIGURE",
          "FOOTER",
          "FORM",
          "H1",
          "H2",
          "H3",
          "H4",
          "H5",
          "H6",
          "HEADER",
          "HGROUP",
          "HR",
          "LI",
          "LISTING",
          "MAIN",
          "MENU",
          "NAV",
          "OL",
          "P",
          "PLAINTEXT",
          "PRE",
          "SEARCH",
          "SECTION",
          "SUMMARY",
          "TABLE",
          "UL",
          "XMP",
        ]);
        const preservedProperties = [
          "align-self",
          "background-color",
          "border-bottom-color",
          "border-bottom-left-radius",
          "border-bottom-right-radius",
          "border-bottom-style",
          "border-bottom-width",
          "border-left-color",
          "border-left-style",
          "border-left-width",
          "border-right-color",
          "border-right-style",
          "border-right-width",
          "border-top-color",
          "border-top-left-radius",
          "border-top-right-radius",
          "border-top-style",
          "border-top-width",
          "box-sizing",
          "color",
          "display",
          "flex-basis",
          "flex-grow",
          "flex-shrink",
          "font-family",
          "font-size",
          "font-stretch",
          "font-style",
          "font-variant",
          "font-weight",
          "grid-area",
          "grid-column-end",
          "grid-column-start",
          "grid-row-end",
          "grid-row-start",
          "height",
          "justify-self",
          "letter-spacing",
          "line-height",
          "margin-bottom",
          "margin-left",
          "margin-right",
          "margin-top",
          "max-height",
          "max-width",
          "min-height",
          "min-width",
          "opacity",
          "order",
          "overflow-wrap",
          "padding-bottom",
          "padding-left",
          "padding-right",
          "padding-top",
          "text-align",
          "text-decoration-color",
          "text-decoration-line",
          "text-decoration-style",
          "text-decoration-thickness",
          "text-indent",
          "text-transform",
          "vertical-align",
          "visibility",
          "white-space",
          "width",
          "word-break",
          "word-spacing",
        ];
        let descendants = 0;
        let paragraphs = 0;

        const parserBreakingDescendants = (paragraph: HTMLParagraphElement) =>
          Array.from(paragraph.querySelectorAll("*")).filter((element) =>
            paragraphBreakingTags.has(element.tagName),
          );

        for (const paragraph of collectElements().filter(
          (element): element is HTMLParagraphElement =>
            element instanceof HTMLParagraphElement,
        )) {
          if (!paragraph.isConnected) {
            continue;
          }

          const breakingDescendants = parserBreakingDescendants(paragraph);
          if (breakingDescendants.length === 0) {
            continue;
          }

          const style = getComputedStyle(paragraph);
          const replacement = document.createElement("div");

          for (const attribute of Array.from(paragraph.attributes)) {
            replacement.setAttribute(attribute.name, attribute.value);
          }
          replacement.setAttribute("data-breamer-original-tag", "p");

          for (const property of preservedProperties) {
            const value = style.getPropertyValue(property);
            if (value) {
              replacement.style.setProperty(
                property,
                value,
                style.getPropertyPriority(property),
              );
            }
          }

          while (paragraph.firstChild) {
            replacement.appendChild(paragraph.firstChild);
          }

          paragraph.replaceWith(replacement);
          descendants += breakingDescendants.length;
          paragraphs++;
        }

        return { descendants, paragraphs };
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

      const normalizedParserUnsafeParagraphs =
        normalizeParserUnsafeParagraphs();
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
        normalizedParserUnsafeParagraphs,
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
  const pendingCaptureSnapshotIds = new Set<string>();
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

    if (message?.method === "Page.captureSnapshot") {
      const key = cdpIdKey(message.id);
      if (key) {
        pendingCaptureSnapshotIds.add(key);
      }
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

      if (pendingCaptureSnapshotIds.delete(key)) {
        const result = message?.result as { data?: unknown } | undefined;
        if (typeof result?.data === "string") {
          const embeddedSnapshot = await embedExternalFontResourcesInMhtml(
            result.data,
          );
          result.data = embeddedSnapshot.data;
          if (client.readyState === WebSocket.OPEN) {
            sendFrame(client, JSON.stringify(message), false);
          }
          return;
        }
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
