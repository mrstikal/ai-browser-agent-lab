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
 * The production base URL is fixed. A loopback mock override is accepted only
 * in explicit test mode with its own temporary DATA_DIR, so a real key cannot
 * be redirected to another server by setting one environment variable.
 */
export function resolveOpenRouterBaseUrl(env: StorageEnv = process.env): string {
  const configured = env.OPENROUTER_BASE_URL?.trim();
  if (!configured) return DEFAULT_OPENROUTER_BASE_URL;

  if (env.LAB_TEST_MODE !== "1") {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL is only allowed together with LAB_TEST_MODE=1 and a temporary DATA_DIR.",
    );
  }
  if (!env.DATA_DIR?.trim()) {
    throw new OpenRouterConfigError(
      "OPENROUTER_BASE_URL requires an explicit temporary DATA_DIR in test mode.",
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${normalizedKey}`,
          accept: "application/json",
        },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        return result("unavailable", { reason: "timeout" });
      }
      return result("unavailable", { reason: "network" });
    }

    if (response.status === 401) return result("invalid", { httpStatus: 401 });
    if (response.status !== 200) {
      return result("unavailable", { httpStatus: response.status });
    }

    const body = await readBoundedResponseText(response, maxBytes);
    if (!body.ok) {
      if (body.code === "too-large") {
        return result("invalid-response", { httpStatus: 200 });
      }
      if (controller.signal.aborted) {
        return result("unavailable", { reason: "timeout" });
      }
      return result("unavailable", { reason: "network" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return result("invalid-response", { httpStatus: 200 });
    }
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
  } finally {
    clearTimeout(timer);
  }
}
