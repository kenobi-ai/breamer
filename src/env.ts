import { z } from "zod";

// pokayoke-ignore-file: typescript/no-optional-env -- A few optional env vars are public runtime overrides; core browser sizing is required.

const booleanString = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value): boolean =>
    typeof value === "boolean" ? value : value === "true",
  );

const colorGamut = z.enum(["srgb", "p3", "rec2020"]);
const colorScheme = z.enum(["light", "dark"]);
const reducedMotion = z.enum(["no-preference", "reduce"]);

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  CHROME_DEBUG_PORT: z.coerce.number().int().positive().default(9222),
  HEADLESS: booleanString.default(false),
  PAGE_TIMEOUT_MS: z.coerce.number().int().positive(),
  CHROME_HEAP_SIZE_MB: z.coerce.number().int().positive(),
  BROWSER_WIDTH: z.coerce.number().int().positive(),
  BROWSER_HEIGHT: z.coerce.number().int().positive(),
  BROWSER_DEVICE_SCALE_FACTOR: z.coerce.number().positive(),
  BROWSER_LOCALE: z.string().min(1),
  BROWSER_USER_AGENT: z.string().optional(),
  BROWSER_PLATFORM: z.string().default("MacIntel"),
  BROWSER_CLIENT_HINT_PLATFORM: z.string().default("macOS"),
  BROWSER_CLIENT_HINT_ARCHITECTURE: z.string().default("arm"),
  BROWSER_CLIENT_HINT_PLATFORM_VERSION: z.string().default("15.0.0"),
  BROWSER_COLOR_GAMUT: colorGamut.default("p3"),
  BROWSER_HARDWARE_CONCURRENCY: z.coerce.number().int().positive().default(10),
  BROWSER_DEVICE_MEMORY_GB: z.coerce.number().int().positive().default(8),
  BROWSER_PREFERS_COLOR_SCHEME: colorScheme.default("light"),
  BROWSER_PREFERS_REDUCED_MOTION: reducedMotion.default("no-preference"),
  BROWSER_TIMEZONE: z.string().default("Europe/London"),
  ARCHIVE_SETTLE_BEFORE_CAPTURE: booleanString.default(true),
  ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE: booleanString.default(true),
  ARCHIVE_SETTLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ARCHIVE_RASTERIZE_DYNAMIC_MEDIA: booleanString.default(true),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  ACCESS_TOKEN: z.string().optional(),
  PUBLIC_ORIGIN: z.string().url().optional(),
  TUNNEL_HOSTNAME: z.string().optional(),
  BROWSER_HOSTNAME: z.string().optional(),
  CDP_PROXY: booleanString.default(true),
  CDP_PROXY_PATH: z
    .string()
    .default("/cdp")
    .transform((value) =>
      value.startsWith("/") ? value.replace(/\/+$/, "") : `/${value}`,
    ),
  SHUTDOWN_PATH: z
    .string()
    .default("/shutdown")
    .transform((value) =>
      value.startsWith("/") ? value.replace(/\/+$/, "") : `/${value}`,
    ),
});

export type Env = z.infer<typeof envSchema>;

export const parseEnv = (overrides: Partial<Env> = {}): Env => {
  return envSchema.parse({
    HOST: overrides.HOST ?? process.env.HOST,
    PORT: overrides.PORT ?? process.env.PORT,
    CHROME_DEBUG_PORT:
      overrides.CHROME_DEBUG_PORT ?? process.env.CHROME_DEBUG_PORT,
    HEADLESS: overrides.HEADLESS ?? process.env.HEADLESS,
    PAGE_TIMEOUT_MS: overrides.PAGE_TIMEOUT_MS ?? process.env.PAGE_TIMEOUT_MS,
    CHROME_HEAP_SIZE_MB:
      overrides.CHROME_HEAP_SIZE_MB ?? process.env.CHROME_HEAP_SIZE_MB,
    BROWSER_WIDTH: overrides.BROWSER_WIDTH ?? process.env.BROWSER_WIDTH,
    BROWSER_HEIGHT: overrides.BROWSER_HEIGHT ?? process.env.BROWSER_HEIGHT,
    BROWSER_DEVICE_SCALE_FACTOR:
      overrides.BROWSER_DEVICE_SCALE_FACTOR ??
      process.env.BROWSER_DEVICE_SCALE_FACTOR,
    BROWSER_LOCALE: overrides.BROWSER_LOCALE ?? process.env.BROWSER_LOCALE,
    BROWSER_USER_AGENT:
      overrides.BROWSER_USER_AGENT ?? process.env.BROWSER_USER_AGENT,
    BROWSER_PLATFORM:
      overrides.BROWSER_PLATFORM ?? process.env.BROWSER_PLATFORM,
    BROWSER_CLIENT_HINT_PLATFORM:
      overrides.BROWSER_CLIENT_HINT_PLATFORM ??
      process.env.BROWSER_CLIENT_HINT_PLATFORM,
    BROWSER_CLIENT_HINT_ARCHITECTURE:
      overrides.BROWSER_CLIENT_HINT_ARCHITECTURE ??
      process.env.BROWSER_CLIENT_HINT_ARCHITECTURE,
    BROWSER_CLIENT_HINT_PLATFORM_VERSION:
      overrides.BROWSER_CLIENT_HINT_PLATFORM_VERSION ??
      process.env.BROWSER_CLIENT_HINT_PLATFORM_VERSION,
    BROWSER_COLOR_GAMUT:
      overrides.BROWSER_COLOR_GAMUT ?? process.env.BROWSER_COLOR_GAMUT,
    BROWSER_HARDWARE_CONCURRENCY:
      overrides.BROWSER_HARDWARE_CONCURRENCY ??
      process.env.BROWSER_HARDWARE_CONCURRENCY,
    BROWSER_DEVICE_MEMORY_GB:
      overrides.BROWSER_DEVICE_MEMORY_GB ??
      process.env.BROWSER_DEVICE_MEMORY_GB,
    BROWSER_PREFERS_COLOR_SCHEME:
      overrides.BROWSER_PREFERS_COLOR_SCHEME ??
      process.env.BROWSER_PREFERS_COLOR_SCHEME,
    BROWSER_PREFERS_REDUCED_MOTION:
      overrides.BROWSER_PREFERS_REDUCED_MOTION ??
      process.env.BROWSER_PREFERS_REDUCED_MOTION,
    BROWSER_TIMEZONE:
      overrides.BROWSER_TIMEZONE ?? process.env.BROWSER_TIMEZONE,
    ARCHIVE_SETTLE_BEFORE_CAPTURE:
      overrides.ARCHIVE_SETTLE_BEFORE_CAPTURE ??
      process.env.ARCHIVE_SETTLE_BEFORE_CAPTURE,
    ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE:
      overrides.ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE ??
      process.env.ARCHIVE_AUTO_SCROLL_BEFORE_CAPTURE,
    ARCHIVE_SETTLE_TIMEOUT_MS:
      overrides.ARCHIVE_SETTLE_TIMEOUT_MS ??
      process.env.ARCHIVE_SETTLE_TIMEOUT_MS,
    ARCHIVE_RASTERIZE_DYNAMIC_MEDIA:
      overrides.ARCHIVE_RASTERIZE_DYNAMIC_MEDIA ??
      process.env.ARCHIVE_RASTERIZE_DYNAMIC_MEDIA,
    CHROME_EXECUTABLE_PATH:
      overrides.CHROME_EXECUTABLE_PATH ?? process.env.CHROME_EXECUTABLE_PATH,
    PUPPETEER_EXECUTABLE_PATH:
      overrides.PUPPETEER_EXECUTABLE_PATH ??
      process.env.PUPPETEER_EXECUTABLE_PATH,
    ACCESS_TOKEN: overrides.ACCESS_TOKEN ?? process.env.ACCESS_TOKEN,
    PUBLIC_ORIGIN: overrides.PUBLIC_ORIGIN ?? process.env.PUBLIC_ORIGIN,
    TUNNEL_HOSTNAME: overrides.TUNNEL_HOSTNAME ?? process.env.TUNNEL_HOSTNAME,
    BROWSER_HOSTNAME:
      overrides.BROWSER_HOSTNAME ?? process.env.BROWSER_HOSTNAME,
    CDP_PROXY: overrides.CDP_PROXY ?? process.env.CDP_PROXY,
    CDP_PROXY_PATH: overrides.CDP_PROXY_PATH ?? process.env.CDP_PROXY_PATH,
    SHUTDOWN_PATH: overrides.SHUTDOWN_PATH ?? process.env.SHUTDOWN_PATH,
  });
};
