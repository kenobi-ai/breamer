const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m"
} as const;

type Color = keyof typeof colors;
export type LogDetails = Record<string, unknown>;
type LogLevel = "info" | "success" | "warn" | "error";

const colorize = (text: string, ...colorNames: Color[]): string => {
  if (!process.stdout.isTTY) {
    return text;
  }

  return `${colorNames.map((color) => colors[color]).join("")}${text}${
    colors.reset
  }`;
};

const timestamp = (): string => {
  const now = new Date();
  return colorize(
    `${now.toISOString().replace("T", " ").replace("Z", "")}`,
    "gray"
  );
};

const levelColors: Record<LogLevel, Color[]> = {
  info: ["white"],
  success: ["green"],
  warn: ["yellow"],
  error: ["red", "bright"]
};

const methodColors: Record<string, Color[]> = {
  GET: ["green"],
  POST: ["yellow"],
  PUT: ["blue"],
  PATCH: ["cyan"],
  DELETE: ["red"],
  OPTIONS: ["gray"],
  HEAD: ["gray"]
};

const statusColor = (status: number): Color[] => {
  if (status >= 500) return ["red", "bright"];
  if (status >= 400) return ["yellow"];
  if (status >= 300) return ["cyan"];
  if (status >= 200) return ["green"];
  return ["gray"];
};

const formatDuration = (ms: number): string => {
  if (ms < 1) return colorize("<1ms", "gray");
  if (ms < 100) return colorize(`${Math.round(ms)}ms`, "green");
  if (ms < 500) return colorize(`${Math.round(ms)}ms`, "yellow");
  return colorize(`${Math.round(ms)}ms`, "red");
};

const compactValue = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }

  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return error instanceof Error
      ? `unserializable:${error.message}`
      : "unserializable";
  }
};

const quoteIfNeeded = (value: string): string => {
  const shortened = value.length > 220 ? `${value.slice(0, 217)}...` : value;
  return /\s/.test(shortened) ? JSON.stringify(shortened) : shortened;
};

const formatDetails = (details?: LogDetails): string => {
  const entries = Object.entries(details ?? {}).filter(
    ([, value]) => value !== undefined
  );

  if (entries.length === 0) {
    return "";
  }

  return ` ${entries
    .map(([key, value]) => `${key}=${quoteIfNeeded(compactValue(value))}`)
    .join(" ")}`;
};

const normalizeDetails = (
  details?: string | LogDetails
): LogDetails | undefined => {
  if (details === undefined) {
    return undefined;
  }

  return typeof details === "string" ? { details } : details;
};

const write = (
  level: LogLevel,
  scope: string,
  event: string,
  details?: LogDetails
): void => {
  const levelText = colorize(level.toUpperCase().padEnd(7), ...levelColors[level]);
  const scopeText = colorize(scope, "cyan");
  const line = `${timestamp()} ${levelText} ${scopeText}.${event}${formatDetails(
    details
  )}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = {
  event(scope: string, event: string, details?: LogDetails) {
    write("info", scope, event, details);
  },

  request(
    method: string,
    path: string,
    status: number,
    durationMs: number,
    details?: LogDetails
  ) {
    const methodStr = colorize(
      method.padEnd(6),
      ...(methodColors[method] ?? ["white"])
    );
    const statusStr = colorize(String(status), ...statusColor(status));
    console.log(
      `${timestamp()} ${methodStr} ${path} ${statusStr} ${formatDuration(
        durationMs
      )}${formatDetails(details)}`
    );
  },

  browser(event: string, details?: string | LogDetails) {
    write("info", "browser", event, normalizeDetails(details));
  },

  cdp(event: string, details?: unknown) {
    write(
      "info",
      "cdp",
      event,
      typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as LogDetails)
        : normalizeDetails(details === undefined ? undefined : String(details))
    );
  },

  page(event: string, details?: string | LogDetails) {
    write("info", "page", event, normalizeDetails(details));
  },

  target(event: string, type: string, url?: string) {
    const shortUrl =
      url && url.length > 80 ? `${url.slice(0, 77)}...` : url ?? "(blank)";
    write("info", "target", event, { type, url: shortUrl });
  },

  info(message: string, details?: LogDetails) {
    write("info", "app", message, details);
  },

  success(message: string, details?: LogDetails) {
    write("success", "app", message, details);
  },

  warn(message: string, details?: LogDetails) {
    write("warn", "app", message, details);
  },

  error(message: string, err?: unknown) {
    const details =
      err instanceof Error
        ? { error: err.message, stack: err.stack }
        : err === undefined
          ? undefined
          : { error: String(err) };
    write("error", "app", message, details);
  }
};

export type Logger = typeof logger;
