export const DEFAULT_APP_ORIGIN = "http://127.0.0.1:3000";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppConfigError";
  }
}

export interface AppConfig {
  readonly origin: string;
  readonly hostname: string;
  readonly bindHost: string;
  readonly port: number;
}

function fail(message: string): never {
  throw new AppConfigError(message);
}

export type AppConfigEnv = Readonly<Record<string, string | undefined>>;

export function resolveAppConfig(env: AppConfigEnv = process.env): AppConfig {
  const configured = env.APP_ORIGIN;
  const raw = configured === undefined ? DEFAULT_APP_ORIGIN : configured.trim();
  if (!raw) {
    fail(`APP_ORIGIN is empty. Use a loopback origin such as ${DEFAULT_APP_ORIGIN}.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(
      `APP_ORIGIN is not a valid URL: ${JSON.stringify(raw)}. Use a loopback origin such as ${DEFAULT_APP_ORIGIN}.`,
    );
  }

  if (url.protocol !== "http:") {
    fail("APP_ORIGIN must use http:// because the local Next.js server does not terminate TLS.");
  }
  if (url.username || url.password) {
    fail("APP_ORIGIN must not contain credentials.");
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    fail("APP_ORIGIN must use the loopback host 127.0.0.1, localhost, or [::1].");
  }
  if (!url.port) {
    fail(
      "APP_ORIGIN must include an explicit non-default port, for example http://127.0.0.1:3000.",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    fail("APP_ORIGIN must be an origin only, without a path, query, or fragment.");
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("APP_ORIGIN port must be an integer from 1 to 65535.");
  }

  const bindHost =
    url.hostname === "localhost"
      ? "127.0.0.1"
      : url.hostname === "[::1]"
        ? "::1"
        : url.hostname;
  return Object.freeze({
    origin: url.origin,
    hostname: url.hostname,
    bindHost,
    port,
  });
}
