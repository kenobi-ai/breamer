import type { Context } from "hono";
import type { Env } from "./env.js";

export const toWebSocketOrigin = (origin: string): string => {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const isLocalHost = (host: string): boolean => {
  const hostname = new URL(`http://${host}`).hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  );
};

export const inferPublicOrigin = (c: Context, env: Env): string => {
  if (env.PUBLIC_ORIGIN) {
    return env.PUBLIC_ORIGIN;
  }

  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!host) {
    return `http://localhost:${env.PORT}`;
  }

  const forwardedProto = c.req.header("x-forwarded-proto");
  const isLocal = isLocalHost(host);
  const proto = isLocal ? (forwardedProto ?? "http") : "https";

  return `${proto}://${host}`;
};

export const buildDirectBrowserEndpoint = (
  localEndpoint: string,
  env: Env,
): string => {
  if (!env.BROWSER_HOSTNAME) {
    return localEndpoint;
  }

  const hostname = env.BROWSER_HOSTNAME.replace(/^wss?:\/\//, "");
  const scheme =
    hostname.startsWith("localhost") || hostname.startsWith("127.0.0.1")
      ? "ws"
      : "wss";

  return localEndpoint.replace(
    `ws://127.0.0.1:${env.CHROME_DEBUG_PORT}`,
    `${scheme}://${hostname}`,
  );
};

export const buildProxiedBrowserEndpoint = (
  localEndpoint: string,
  publicOrigin: string,
  env: Env,
  publicCdpPath = env.CDP_PROXY_PATH,
): { wsEndpoint: string; proxyPath: string; localPath: string } => {
  const localPath = new URL(localEndpoint).pathname;
  const normalizedPublicCdpPath = publicCdpPath.startsWith("/")
    ? publicCdpPath.replace(/\/+$/, "")
    : `/${publicCdpPath.replace(/\/+$/, "")}`;
  const proxyPath = `${normalizedPublicCdpPath}${localPath}`;
  const wsEndpoint = `${toWebSocketOrigin(publicOrigin)}${proxyPath}`;

  return {
    wsEndpoint,
    proxyPath,
    localPath,
  };
};
