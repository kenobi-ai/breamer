// pokayoke-ignore-file: structure/max-file-lines -- The Worker route table is intentionally explicit so the public API stays easy to audit.

import type { StopParams } from "@cloudflare/containers";
import { Container, getContainer } from "@cloudflare/containers";

const CONTAINER_PORT = 3000;
const CDP_PATH = "/cdp";
const SHUTDOWN_PATH = "/shutdown";
const SESSION_PATH = "/sessions";
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface BreamerEnv extends Env {
  BREAMER_BROWSER_USER_AGENT?: string;
}
type ContainerState = DurableObjectState<Record<PropertyKey, never>>;
type WorkerLogDetails = Record<string, unknown>;

const logWorker = (event: string, details: WorkerLogDetails = {}): void => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "breamer-worker",
      event,
      ...details,
    }),
  );
};

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });

const getBearerToken = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  const url = new URL(request.url);
  return (
    request.headers.get("x-breamer-access-token") ??
    request.headers.get("x-breamer-token") ??
    url.searchParams.get("token") ??
    undefined
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

const authenticateAccess = (
  request: Request,
  env: BreamerEnv,
  requestId?: string,
): Response | undefined => {
  if (!env.BREAMER_ACCESS_TOKEN) {
    logWorker("auth.missing_secret", { requestId });
    return json(
      {
        error: "access_disabled",
        message:
          "Set the BREAMER_ACCESS_TOKEN Worker secret to enable CDP access.",
      },
      { status: 403 },
    );
  }

  const token = getBearerToken(request);
  if (!token || !timingSafeEqual(token, env.BREAMER_ACCESS_TOKEN)) {
    logWorker("auth.denied", {
      requestId,
      tokenProvided: Boolean(token),
    });
    return json({ error: "unauthorized" }, { status: 401 });
  }
};

const forwardableRequest = (
  request: Request,
  options: {
    pathname?: string;
    headers?: Record<string, string>;
  } = {},
): Request => {
  const url = new URL(request.url);
  if (options.pathname) {
    url.pathname = options.pathname;
  }

  const headers = new Headers(request.headers);
  const incomingProto =
    headers.get("x-forwarded-proto") ??
    (() => {
      const visitor = headers.get("cf-visitor");
      if (!visitor) {
        return undefined;
      }

      try {
        const parsed = JSON.parse(visitor) as { scheme?: unknown };
        return typeof parsed.scheme === "string" ? parsed.scheme : undefined;
      } catch (error) {
        logWorker("forwarded_proto_parse_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })();
  const isLocalHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "0.0.0.0" ||
    url.hostname === "::1";

  headers.set("x-forwarded-host", url.host);
  headers.set(
    "x-forwarded-proto",
    incomingProto ?? (isLocalHost ? url.protocol.replace(":", "") : "https"),
  );
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  return new Request(url.toString(), {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: request.redirect,
  });
};

const createSessionId = (): string => crypto.randomUUID();

const parseSessionRoute = (
  pathname: string,
): { sessionId: string; sessionPath: string } | undefined => {
  if (!pathname.startsWith(`${SESSION_PATH}/`)) {
    return undefined;
  }

  const [, , sessionId, ...rest] = pathname.split("/");
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return undefined;
  }

  return {
    sessionId,
    sessionPath: `/${rest.join("/")}`.replace(/\/+$/, "") || "/",
  };
};

export class BreamerBrowserContainer extends Container<BreamerEnv> {
  defaultPort = CONTAINER_PORT;
  requiredPorts = [CONTAINER_PORT];
  sleepAfter = "5m";
  enableInternet = true;

  constructor(ctx: ContainerState, env: BreamerEnv) {
    super(ctx, env);
    this.sleepAfter = env.BREAMER_SLEEP_AFTER ?? "5m";

    this.envVars = {
      HOST: "0.0.0.0",
      PORT: String(CONTAINER_PORT),
      HEADLESS: "true",
      PAGE_TIMEOUT_MS: env.BREAMER_PAGE_TIMEOUT_MS ?? "300000",
      CHROME_HEAP_SIZE_MB: env.BREAMER_CHROME_HEAP_SIZE_MB ?? "4096",
      BROWSER_WIDTH: env.BREAMER_BROWSER_WIDTH ?? "1440",
      BROWSER_HEIGHT: env.BREAMER_BROWSER_HEIGHT ?? "900",
      BROWSER_DEVICE_SCALE_FACTOR:
        env.BREAMER_BROWSER_DEVICE_SCALE_FACTOR ?? "1",
      BROWSER_LOCALE: env.BREAMER_BROWSER_LOCALE ?? "en-US,en",
      CDP_PROXY: "true",
      CDP_PROXY_PATH: "/cdp",
      SHUTDOWN_PATH,
      PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium",
      ...(env.BREAMER_ACCESS_TOKEN
        ? { ACCESS_TOKEN: env.BREAMER_ACCESS_TOKEN }
        : {}),
      ...(env.BREAMER_BROWSER_USER_AGENT
        ? { BROWSER_USER_AGENT: env.BREAMER_BROWSER_USER_AGENT }
        : {}),
    };
  }

  override onStart() {
    logWorker("container.started", {
      port: CONTAINER_PORT,
      sleepAfter: this.sleepAfter,
      pageTimeoutMs: this.env.BREAMER_PAGE_TIMEOUT_MS ?? "300000",
      heapMb: this.env.BREAMER_CHROME_HEAP_SIZE_MB ?? "4096",
    });
  }

  override onStop(params: StopParams) {
    logWorker("container.stopped", params as unknown as WorkerLogDetails);
  }

  override onError(error: unknown) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: "breamer-worker",
        event: "container.error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

export default {
  async fetch(
    request: Request,
    env: BreamerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const requestId =
      request.headers.get("x-breamer-request-id") ?? crypto.randomUUID();
    const startedAt = performance.now();
    const complete = (response: Response, route: string): Response => {
      logWorker("request.complete", {
        requestId,
        route,
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    };

    if (url.pathname === "/" || url.pathname === SHUTDOWN_PATH) {
      return complete(
        json({ error: "not_found" }, { status: 404 }),
        "not_found",
      );
    }

    if (url.pathname === "/_worker/health" || url.pathname === "/health") {
      const authResponse = authenticateAccess(request, env, requestId);
      if (authResponse) {
        return complete(authResponse, "worker.health");
      }

      logWorker("worker.health", {
        requestId,
        accessEnabled: Boolean(env.BREAMER_ACCESS_TOKEN),
        sleepAfter: env.BREAMER_SLEEP_AFTER ?? "5m",
      });

      return complete(
        json({
          status: "ok",
          service: "breamer-worker",
          container: "BreamerBrowserContainer",
          cdpPath: CDP_PATH,
          sessionPath: SESSION_PATH,
          shutdownPath: `${SESSION_PATH}/:sessionId${SHUTDOWN_PATH}`,
          accessEnabled: Boolean(env.BREAMER_ACCESS_TOKEN),
          pageTimeoutMs: env.BREAMER_PAGE_TIMEOUT_MS ?? "300000",
          chromeHeapSizeMb: env.BREAMER_CHROME_HEAP_SIZE_MB ?? "4096",
          browserSize: {
            width: env.BREAMER_BROWSER_WIDTH ?? "1440",
            height: env.BREAMER_BROWSER_HEIGHT ?? "900",
            deviceScaleFactor: env.BREAMER_BROWSER_DEVICE_SCALE_FACTOR ?? "1",
          },
          browserLocale: env.BREAMER_BROWSER_LOCALE ?? "en-US,en",
          sleepAfter: env.BREAMER_SLEEP_AFTER ?? "5m",
        }),
        "worker.health",
      );
    }

    if (url.pathname === CDP_PATH) {
      const authResponse = authenticateAccess(request, env, requestId);
      if (authResponse) {
        return complete(authResponse, "session.create");
      }

      const sessionId = createSessionId();
      const container = getContainer(env.BREAMER, sessionId);
      const publicCdpPath = `${SESSION_PATH}/${sessionId}${CDP_PATH}`;
      const publicShutdownPath = `${SESSION_PATH}/${sessionId}${SHUTDOWN_PATH}`;

      logWorker("session.create", {
        requestId,
        sessionId,
        publicCdpPath,
        publicShutdownPath,
      });

      const response = await container.fetch(
        forwardableRequest(request, {
          pathname: CDP_PATH,
          headers: {
            "x-breamer-request-id": requestId,
            "x-breamer-session-id": sessionId,
            "x-breamer-public-cdp-path": publicCdpPath,
            "x-breamer-public-shutdown-path": publicShutdownPath,
          },
        }),
      );
      return complete(response, "session.create");
    }

    const sessionRoute = parseSessionRoute(url.pathname);
    if (sessionRoute) {
      const { sessionId, sessionPath } = sessionRoute;
      const container = getContainer(env.BREAMER, sessionId);

      if (sessionPath === SHUTDOWN_PATH) {
        logWorker("session.shutdown", { requestId, sessionId });
        const response = await container.fetch(
          forwardableRequest(request, {
            pathname: SHUTDOWN_PATH,
            headers: {
              "x-breamer-request-id": requestId,
              "x-breamer-session-id": sessionId,
            },
          }),
        );

        if (response.ok) {
          ctx.waitUntil(
            container.stop("SIGTERM").catch((error) => {
              console.error("Failed to stop Breamer browser container", error);
            }),
          );
        }

        return complete(response, "session.shutdown");
      }

      if (sessionPath === "/health" || sessionPath === "/ready") {
        const authResponse = authenticateAccess(request, env, requestId);
        if (authResponse) {
          return complete(authResponse, "session.status");
        }
      }

      if (
        sessionPath === CDP_PATH ||
        sessionPath.startsWith(`${CDP_PATH}/`) ||
        sessionPath === "/health" ||
        sessionPath === "/ready"
      ) {
        logWorker("session.forward", {
          requestId,
          sessionId,
          sessionPath,
        });
        const response = await container.fetch(
          forwardableRequest(request, {
            pathname: sessionPath,
            headers: {
              "x-breamer-request-id": requestId,
              "x-breamer-session-id": sessionId,
              "x-breamer-public-cdp-path": `${SESSION_PATH}/${sessionId}${CDP_PATH}`,
              "x-breamer-public-shutdown-path": `${SESSION_PATH}/${sessionId}${SHUTDOWN_PATH}`,
            },
          }),
        );
        return complete(response, "session.forward");
      }
    }

    if (url.pathname === "/ready") {
      const authResponse = authenticateAccess(request, env, requestId);
      if (authResponse) {
        return complete(authResponse, "worker.ready");
      }

      return complete(
        json(
          {
            error: "session_required",
            message:
              "Use /cdp to create a session, then call /sessions/:sessionId/ready.",
          },
          { status: 400 },
        ),
        "worker.ready",
      );
    }

    return complete(json({ error: "not_found" }, { status: 404 }), "not_found");
  },
};
