import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ZodType } from "zod";
import {
  resolveAppConfig,
  type AppConfig,
  type AppConfigEnv,
} from "./config";

export const CSRF_HEADER = "x-lab-csrf-token";
export const DEFAULT_MAX_MUTATION_BODY_BYTES = 64 * 1024;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type MutationGuardCode =
  | "server-misconfigured"
  | "method-not-allowed"
  | "forbidden-host"
  | "forbidden-origin"
  | "missing-csrf-token"
  | "invalid-csrf-token"
  | "unsupported-media-type"
  | "payload-too-large"
  | "unreadable-body"
  | "invalid-json"
  | "invalid-body";

export interface MutationGuardIssue {
  readonly path: string;
  readonly message: string;
}

export type GuardedMutationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: Response };

export type BoundaryCheckResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly response: Response };

export interface BoundaryCheckOptions {
  readonly config?: AppConfig | undefined;
  readonly env?: AppConfigEnv | undefined;
}

export interface MutationGuardOptions<T> extends BoundaryCheckOptions {
  readonly schema: ZodType<T>;
  readonly maxBytes?: number | undefined;
  readonly requireCsrfWhenOriginAbsent?: boolean | undefined;
}

const CSRF_TOKEN_HOLDER_KEY = Symbol.for(
  "ai-browser-agent-lab.csrf-token-holder",
);

interface CsrfTokenHolder {
  token?: string;
}

function csrfHolder(): CsrfTokenHolder {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[CSRF_TOKEN_HOLDER_KEY] as CsrfTokenHolder | undefined;
  if (existing) return existing;
  const created: CsrfTokenHolder = {};
  host[CSRF_TOKEN_HOLDER_KEY] = created;
  return created;
}

export function getCsrfToken(): string {
  const holder = csrfHolder();
  if (!holder.token) {
    holder.token = randomBytes(32).toString("base64url");
  }
  return holder.token;
}

export function verifyCsrfToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = csrfHolder().token;
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(token);
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

function errorResponse(
  status: number,
  code: MutationGuardCode,
  message: string,
  options: {
    readonly issues?: readonly MutationGuardIssue[];
    readonly headers?: Record<string, string>;
  } = {},
): Response {
  const error: {
    code: MutationGuardCode;
    message: string;
    issues?: readonly MutationGuardIssue[];
  } = options.issues
    ? { code, message, issues: options.issues }
    : { code, message };
  return Response.json(
    { error },
    {
      status,
      headers: { "cache-control": "no-store", ...options.headers },
    },
  );
}

function guardFailure<T>(
  status: number,
  code: MutationGuardCode,
  message: string,
  options: {
    readonly issues?: readonly MutationGuardIssue[];
    readonly headers?: Record<string, string>;
  } = {},
): GuardedMutationResult<T> {
  return { ok: false, response: errorResponse(status, code, message, options) };
}

function boundaryFailure(
  status: number,
  code: MutationGuardCode,
  message: string,
): BoundaryCheckResult {
  return { ok: false, response: errorResponse(status, code, message) };
}

function resolveConfig(options: BoundaryCheckOptions): AppConfig | undefined {
  try {
    return options.config ?? resolveAppConfig(options.env ?? process.env);
  } catch {
    return undefined;
  }
}

function expectedHost(config: AppConfig): string {
  return new URL(config.origin).host.toLowerCase();
}

function requestHostMatches(request: Request, config: AppConfig): boolean {
  const host = request.headers.get("host");
  if (host === null) return false;
  return host.trim().toLowerCase() === expectedHost(config);
}

type RequestOrigin = "same" | "absent" | "other";

function requestOrigin(request: Request, config: AppConfig): RequestOrigin {
  const origin = request.headers.get("origin");
  if (origin === null) return "absent";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "other";
  }
  if (url.username || url.password) return "other";
  if (url.pathname !== "/" || url.search || url.hash) return "other";
  return `${url.protocol}//${url.host}` === config.origin ? "same" : "other";
}

/**
 * Host + Origin boundary for local routes. GET requests may omit Origin; any
 * provided Origin must match APP_ORIGIN exactly. Mutating requests add the
 * CSRF-token fallback in readGuardedMutation.
 */
export function checkRequestBoundary(
  request: Request,
  options: BoundaryCheckOptions = {},
): BoundaryCheckResult {
  const config = resolveConfig(options);
  if (!config) {
    return boundaryFailure(
      500,
      "server-misconfigured",
      "APP_ORIGIN is not configured as a valid loopback origin.",
    );
  }
  if (!requestHostMatches(request, config)) {
    return boundaryFailure(
      403,
      "forbidden-host",
      "The Host header does not match the configured loopback origin.",
    );
  }
  if (requestOrigin(request, config) === "other") {
    return boundaryFailure(
      403,
      "forbidden-origin",
      "The Origin header does not match the configured loopback origin.",
    );
  }
  return { ok: true, config };
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

// Content-Length is only a fast pre-check. The stream is the authority: the
// first chunk that crosses maxBytes is rejected without being appended, so the
// retained buffer never exceeds maxBytes plus the runtime's current chunk.
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "payload-too-large" | "unreadable-body" }
> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    return { ok: false, code: "payload-too-large" };
  }

  if (!request.body) return { ok: true, text: "" };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, code: "unreadable-body" };
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
        return { ok: false, code: "payload-too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "unreadable-body" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be released after cancel.
    }
  }

  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

export async function readGuardedMutation<T>(
  request: Request,
  options: MutationGuardOptions<T>,
): Promise<GuardedMutationResult<T>> {
  const method = request.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return guardFailure(
      405,
      "method-not-allowed",
      "Only POST, PUT, PATCH, and DELETE mutations are guarded here.",
      { headers: { allow: "POST, PUT, PATCH, DELETE" } },
    );
  }

  const boundary = checkRequestBoundary(request, options);
  if (!boundary.ok) return boundary;

  const origin = requestOrigin(request, boundary.config);
  if (options.requireCsrfWhenOriginAbsent !== false && origin === "absent") {
    const token = request.headers.get(CSRF_HEADER);
    if (token === null || token.trim().length === 0) {
      return guardFailure(
        403,
        "missing-csrf-token",
        "An exact same-origin Origin header or a server-issued CSRF token is required.",
      );
    }
    if (!verifyCsrfToken(token)) {
      return guardFailure(
        403,
        "invalid-csrf-token",
        "The provided CSRF token is not valid for this server process.",
      );
    }
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return guardFailure(
      415,
      "unsupported-media-type",
      "State-changing requests must use Content-Type: application/json.",
    );
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MUTATION_BODY_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    return guardFailure(
      500,
      "server-misconfigured",
      "The mutation body limit must be a positive integer.",
    );
  }
  const body = await readBoundedBody(request, maxBytes);
  if (!body.ok) {
    if (body.code === "payload-too-large") {
      return guardFailure(
        413,
        "payload-too-large",
        `The JSON body exceeds the ${maxBytes}-byte limit.`,
      );
    }
    return guardFailure(400, "unreadable-body", "The request body could not be read.");
  }

  if (body.text.trim().length === 0) {
    return guardFailure(
      400,
      "invalid-json",
      "The request body is empty or contains only whitespace.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return guardFailure(400, "invalid-json", "The request body is not valid JSON.");
  }

  const result = options.schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join("."),
      message: issue.message,
    }));
    return guardFailure(
      422,
      "invalid-body",
      "The request body does not match the expected schema.",
      { issues },
    );
  }

  return { ok: true, data: result.data };
}
