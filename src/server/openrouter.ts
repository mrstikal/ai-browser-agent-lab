import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { StorageEnv } from "./storage";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_KEY_VALIDATION_TIMEOUT_MS = 10_000;
export const DEFAULT_KEY_RESPONSE_MAX_BYTES = 64 * 1024;
export const MIN_OPENROUTER_KEY_LENGTH = 8;
export const MAX_OPENROUTER_KEY_LENGTH = 512;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class OpenRouterConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenRouterConfigError";
  }
}

export class OpenRouterKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterKeyFormatError";
  }
}

/**
 * Resolves symlinks for the deepest existing ancestor so a temp directory
 * cannot be disguised as another location (or vice versa). Non-existing
 * suffixes are appended after the canonical ancestor.
 */
function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(current, ...suffix);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * True only for a data directory below an OS temp root.
 */
export function isTemporaryDataDir(dataDir: string): boolean {
  const candidate = canonicalPath(dataDir);
  const roots = new Set<string>();
  for (const root of [tmpdir(), "/tmp"]) {
    try {
      roots.add(canonicalPath(root));
    } catch {
      // A missing platform temp root simply cannot match.
    }
  }
  return [...roots].some((root) => isStrictlyInside(root, candidate));
}

/**
 * A disposable test data directory is below an OS temp root and outside the
 * project tree. The project check also covers a repository checked out below a
 * temp root, where its normal `data/` directory would otherwise pass the
 * temp-root test and expose a remembered production key to a loopback mock.
 */
export function isDisposableTestDataDir(
  dataDir: string,
  projectRoot: string = process.cwd(),
): boolean {
  if (!isTemporaryDataDir(dataDir)) return false;
  const root = canonicalPath(projectRoot);
  const candidate = canonicalPath(dataDir);
  return candidate !== root && !isStrictlyInside(root, candidate);
}

/**
 * The production base URL is fixed. A loopback mock override is accepted only
 * in explicit test mode with its own disposable DATA_DIR, so a real key cannot
 * be redirected to another server by setting one environment variable.
 */
export function resolveOpenRouterBaseUrl(
  env: StorageEnv = process.env,
  projectRoot: string = process.cwd(),
): string {
  const configured = env.OPENROUTER_BASE_URL?.trim();
  if (!configured) return DEFAULT_OPENROUTER_BASE_URL;

  if (env.LAB_TEST_MODE !== "1") {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL is only allowed together with LAB_TEST_MODE=1 and a temporary DATA_DIR.",
    );
  }
  const dataDir = env.DATA_DIR?.trim();
  if (!dataDir) {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL requires an explicit temporary DATA_DIR in test mode.",
    );
  }
  if (!isDisposableTestDataDir(dataDir, projectRoot)) {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL requires a temporary DATA_DIR below the OS temp directory and outside the project directory in test mode.",
    );
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch (error) {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL must be a valid URL.",
      { cause: error },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenRouterConfigError("OPENROUTER_BASE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new OpenRouterConfigError("OPENROUTER_BASE_URL must not contain credentials.");
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL may only point at a loopback host in test mode.",
    );
  }
  if (!url.port) {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL must include an explicit port.",
    );
  }
  if (url.search || url.hash) {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL must not contain a query or fragment.",
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function openRouterEndpoint(baseUrl: string, endpoint: string): string {
  const cleanEndpoint = endpoint.replace(/^\/+/, "");
  if (!cleanEndpoint) {
    throw new OpenRouterConfigError("An OpenRouter endpoint path is required.");
  }
  return `${baseUrl.replace(/\/+$/, "")}/${cleanEndpoint}`;
}

export function normalizeOpenRouterKey(key: string): string {
  if (typeof key !== "string") {
    throw new OpenRouterKeyFormatError("The API key must be a string.");
  }
  const trimmed = key.trim();
  if (
    trimmed.length < MIN_OPENROUTER_KEY_LENGTH ||
    trimmed.length > MAX_OPENROUTER_KEY_LENGTH
  ) {
    throw new OpenRouterKeyFormatError(
      `The API key must be ${MIN_OPENROUTER_KEY_LENGTH}-${MAX_OPENROUTER_KEY_LENGTH} characters long.`,
    );
  }
  if (/[^\u0021-\u007e]/.test(trimmed)) {
    throw new OpenRouterKeyFormatError(
      "The API key must contain only printable non-space ASCII characters.",
    );
  }
  return trimmed;
}

export type KeyValidationStatus =
  | "valid"
  | "invalid"
  | "unavailable"
  | "invalid-response";

export interface KeyValidationResult {
  readonly status: KeyValidationStatus;
  readonly managementOnly: boolean;
  readonly inferenceAccess: "unverified";
  readonly httpStatus: number | null;
  readonly reason: "network" | "timeout" | null;
}

export interface ValidateOpenRouterKeyOptions {
  readonly env?: StorageEnv | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new OpenRouterConfigError(`${label} must be a positive integer.`);
  }
  return resolved;
}

function result(
  status: KeyValidationStatus,
  options: {
    readonly managementOnly?: boolean;
    readonly httpStatus?: number | null;
    readonly reason?: "network" | "timeout" | null;
  } = {},
): KeyValidationResult {
  return {
    status,
    managementOnly: options.managementOnly ?? false,
    inferenceAccess: "unverified",
    httpStatus: options.httpStatus ?? null,
    reason: options.reason ?? null,
  };
}

function isManagementOnly(data: Record<string, unknown>): boolean {
  return data.is_management_key === true || data.is_provisioning_key === true;
}

type BoundedBodyResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "too-large" | "read-error" };

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    return { ok: false, code: "too-large" };
  }
  if (!response.body) return { ok: true, text: "" };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return { ok: false, code: "read-error" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "read-error" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released after cancel.
    }
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

const MAX_RETRY_AFTER_SECONDS = 3600;

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return Math.max(0, Math.min(seconds, MAX_RETRY_AFTER_SECONDS));
}

export interface FetchOpenRouterJsonOptions {
  readonly headers?: Record<string, string> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export type FetchOpenRouterJsonResult =
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | {
      readonly ok: false;
      readonly kind: "http";
      readonly status: number;
      readonly retryAfterSeconds: number | null;
    }
  | {
      readonly ok: false;
      readonly kind: "network" | "timeout" | "invalid-response";
    };

interface OpenRouterJsonRequest {
  readonly method: "GET" | "POST";
  readonly body?: string;
}

async function executeOpenRouterJsonRequest(
  url: string,
  request: OpenRouterJsonRequest,
  options: FetchOpenRouterJsonOptions,
): Promise<FetchOpenRouterJsonResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_KEY_VALIDATION_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxBytes = positiveInteger(
    options.maxBytes,
    DEFAULT_KEY_RESPONSE_MAX_BYTES,
    "maxBytes",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      const init: RequestInit = {
        method: request.method,
        headers: { accept: "application/json", ...options.headers },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      };
      if (request.body !== undefined) init.body = request.body;
      response = await fetchImpl(url, init);
    } catch {
      if (controller.signal.aborted) return { ok: false, kind: "timeout" };
      return { ok: false, kind: "network" };
    }

    if (!response.ok) {
      return {
        ok: false,
        kind: "http",
        status: response.status,
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
      };
    }

    const body = await readBoundedResponseText(response, maxBytes);
    if (!body.ok) {
      if (body.code === "too-large") {
        return { ok: false, kind: "invalid-response" };
      }
      if (controller.signal.aborted) return { ok: false, kind: "timeout" };
      return { ok: false, kind: "network" };
    }

    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      return { ok: false, kind: "invalid-response" };
    }
    return { ok: true, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared guarded GET for OpenRouter JSON endpoints: fixed base URL from the
 * resolver, redirects rejected, whole-operation timeout (headers and body),
 * bounded response size, and no raw error passthrough.
 */
export async function fetchOpenRouterJson(
  url: string,
  options: FetchOpenRouterJsonOptions = {},
): Promise<FetchOpenRouterJsonResult> {
  return executeOpenRouterJsonRequest(url, { method: "GET" }, options);
}

/**
 * Guarded POST for OpenRouter JSON endpoints. Use only from adapters that
 * already hold a confirmed quote; the body is serialized here and never logged.
 */
export async function postOpenRouterJson(
  url: string,
  body: unknown,
  options: FetchOpenRouterJsonOptions = {},
): Promise<FetchOpenRouterJsonResult> {
  return executeOpenRouterJsonRequest(
    url,
    { method: "POST", body: JSON.stringify(body) },
    {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
    },
  );
}

/**
 * Non-billable credential check against GET /key. It returns only safe status
 * fields: no key, label, usage, limits, or other raw endpoint metadata.
 */
export async function validateOpenRouterKey(
  key: string,
  options: ValidateOpenRouterKeyOptions = {},
): Promise<KeyValidationResult> {
  const normalizedKey = normalizeOpenRouterKey(key);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_KEY_VALIDATION_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxBytes = positiveInteger(
    options.maxBytes,
    DEFAULT_KEY_RESPONSE_MAX_BYTES,
    "maxBytes",
  );
  const url = openRouterEndpoint(resolveOpenRouterBaseUrl(env), "key");

  const fetched = await fetchOpenRouterJson(url, {
    headers: { authorization: `Bearer ${normalizedKey}` },
    fetchImpl,
    timeoutMs,
    maxBytes,
  });
  if (!fetched.ok) {
    if (fetched.kind === "http") {
      if (fetched.status === 401) return result("invalid", { httpStatus: 401 });
      return result("unavailable", { httpStatus: fetched.status });
    }
    if (fetched.kind === "timeout") {
      return result("unavailable", { reason: "timeout" });
    }
    if (fetched.kind === "network") {
      return result("unavailable", { reason: "network" });
    }
    return result("invalid-response", { httpStatus: 200 });
  }
  // The key-validation contract is a strict 200 response. A 2xx other than
  // 200 is not a valid validation answer even if the body looks plausible.
  if (fetched.status !== 200) {
    return result("invalid-response", { httpStatus: fetched.status });
  }

  const parsed = fetched.json;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return result("invalid-response", { httpStatus: 200 });
  }
  const data = (parsed as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return result("invalid-response", { httpStatus: 200 });
  }

  return result("valid", {
    httpStatus: 200,
    managementOnly: isManagementOnly(data as Record<string, unknown>),
  });
}
