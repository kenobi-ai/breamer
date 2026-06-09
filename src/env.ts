import { z } from "zod";

// pokayoke-ignore-file: typescript/no-optional-env -- A few optional env vars are public runtime overrides; core browser sizing is required.

const booleanString = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value): boolean =>
    typeof value === "boolean" ? value : value === "true",
  );

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
