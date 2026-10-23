import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveAppConfig } from "../src/server/config";
import {
  checkRequestBoundary,
  CSRF_HEADER,
  DEFAULT_MAX_MUTATION_BODY_BYTES,
  getCsrfToken,
  readGuardedMutation,
  verifyCsrfToken,
} from "../src/server/mutation-guard";

const config = resolveAppConfig({ APP_ORIGIN: "http://127.0.0.1:3000" });

const schema = z.strictObject({
  message: z.string().min(1).max(10),
  count: z.number().int().min(0).max(5),
});

interface RequestOptions {
  readonly method?: string;
  readonly host?: string | null;
  readonly origin?: string | null;
  readonly token?: string | null;
  readonly contentType?: string | null;
  readonly body?: string;
  readonly path?: string;
}

function makeRequest(options: RequestOptions = {}): Request {
  const headers = new Headers();
  if (options.host !== null) headers.set("host", options.host ?? "127.0.0.1:3000");
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "http://127.0.0.1:3000");
  }
  if (options.token) headers.set(CSRF_HEADER, options.token);
  if (options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  const init: RequestInit = { method: options.method ?? "POST", headers };
  if (options.body !== undefined) init.body = options.body;
  return new Request(
    `http://127.0.0.1:3000${options.path ?? "/api/lab/mutation-probe"}`,
    init,
  );
}

async function errorBody(response: Response): Promise<{ error: { code: string; issues?: unknown } }> {
  return (await response.json()) as { error: { code: string; issues?: unknown } };
}

describe("mutation guard", () => {
  it("accepts a same-origin JSON mutation with a valid schema", async () => {
    const result = await readGuardedMutation(
      makeRequest({ body: JSON.stringify({ message: "hello", count: 2 }) }),
      { schema, config },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ message: "hello", count: 2 });
    }
  });

  it("requires an exact same-origin Origin or a server-issued CSRF token", async () => {
    const missing = await readGuardedMutation(
      makeRequest({ origin: null, body: "{}" }),
      { schema, config },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(403);
      expect((await errorBody(missing.response)).error.code).toBe(
        "missing-csrf-token",
      );
      expect(missing.response.headers.get("access-control-allow-origin")).toBeNull();
      expect(missing.response.headers.get("cache-control")).toBe("no-store");
    }

    const wrongToken = await readGuardedMutation(
      makeRequest({ origin: null, token: "not-the-token", body: "{}" }),
      { schema, config },
    );
    expect(wrongToken.ok).toBe(false);
    if (!wrongToken.ok) {
      expect((await errorBody(wrongToken.response)).error.code).toBe(
        "invalid-csrf-token",
      );
    }

    const token = getCsrfToken();
    const accepted = await readGuardedMutation(
      makeRequest({
        origin: null,
        token,
        body: JSON.stringify({ message: "ok", count: 1 }),
      }),
      { schema, config },
    );
    expect(accepted.ok).toBe(true);
  });

  it("rejects cross-origin requests and wrong Host headers before reading the body", async () => {
    const crossOrigin = await readGuardedMutation(
      makeRequest({
        origin: "http://127.0.0.1:3999",
        body: JSON.stringify({ message: "hello", count: 1 }),
      }),
      { schema, config },
    );
    expect(crossOrigin.ok).toBe(false);
    if (!crossOrigin.ok) {
      expect(crossOrigin.response.status).toBe(403);
      expect((await errorBody(crossOrigin.response)).error.code).toBe(
        "forbidden-origin",
      );
    }

    const nullOrigin = await readGuardedMutation(
      makeRequest({ origin: "null", body: "{}" }),
      { schema, config },
    );
    expect(nullOrigin.ok).toBe(false);
    if (!nullOrigin.ok) {
      expect((await errorBody(nullOrigin.response)).error.code).toBe(
        "forbidden-origin",
      );
    }

    for (const host of ["evil.example:3000", "127.0.0.1:3999", null]) {
      const result = await readGuardedMutation(
        makeRequest({ host, body: "{}" }),
        { schema, config },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        expect((await errorBody(result.response)).error.code).toBe(
          "forbidden-host",
        );
      }
    }
  });

  it("enforces JSON content type, bounded size, valid JSON, and the schema", async () => {
    const wrongType = await readGuardedMutation(
      makeRequest({ contentType: "text/plain", body: "{}" }),
      { schema, config },
    );
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.response.status).toBe(415);
    }

    const tooLarge = await readGuardedMutation(
      makeRequest({ body: `"${"x".repeat(80)}"` }),
      { schema, config, maxBytes: 32 },
    );
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(tooLarge.response.status).toBe(413);
      expect((await errorBody(tooLarge.response)).error.code).toBe(
        "payload-too-large",
      );
    }

    const malformed = await readGuardedMutation(
      makeRequest({ body: "{not json" }),
      { schema, config },
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.response.status).toBe(400);
      expect((await errorBody(malformed.response)).error.code).toBe(
        "invalid-json",
      );
    }

    const empty = await readGuardedMutation(makeRequest({}), { schema, config });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect((await errorBody(empty.response)).error.code).toBe("invalid-json");
    }

    const invalid = await readGuardedMutation(
      makeRequest({ body: JSON.stringify({ message: "", count: "two" }) }),
      { schema, config },
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.response.status).toBe(422);
      const body = await errorBody(invalid.response);
      expect(body.error.code).toBe("invalid-body");
      expect(Array.isArray(body.error.issues)).toBe(true);
    }

    const extraField = await readGuardedMutation(
      makeRequest({
        body: JSON.stringify({ message: "hello", count: 1, extra: true }),
      }),
      { schema, config },
    );
    expect(extraField.ok).toBe(false);
  });

  it("rejects loopback aliases, userinfo, and origin-like strings with paths", async () => {
    for (const origin of [
      "http://localhost:3000",
      "http://user:pass@127.0.0.1:3000",
      "http://127.0.0.1:3000/evil",
      "http://127.0.0.1:3000?x=1",
    ]) {
      const result = await readGuardedMutation(
        makeRequest({ origin, body: "{}" }),
        { schema, config },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        expect((await errorBody(result.response)).error.code).toBe(
          "forbidden-origin",
        );
      }
    }
  });

  it("caps streamed bodies without Content-Length and supports the CSRF opt-out", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`"${"x".repeat(80)}"`));
        controller.close();
      },
    });
    const streamInit = {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" };
    const streamed = new Request(
      "http://127.0.0.1:3000/api/lab/mutation-probe",
      streamInit,
    );
    expect(streamed.headers.get("content-length")).toBeNull();
    const tooLarge = await readGuardedMutation(streamed, {
      schema,
      config,
      maxBytes: 32,
    });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(tooLarge.response.status).toBe(413);
    }

    const optOut = await readGuardedMutation(
      makeRequest({
        origin: null,
        body: JSON.stringify({ message: "ok", count: 1 }),
      }),
      { schema, config, requireCsrfWhenOriginAbsent: false },
    );
    expect(optOut.ok).toBe(true);

    const whitespace = await readGuardedMutation(makeRequest({ body: "   " }), {
      schema,
      config,
    });
    expect(whitespace.ok).toBe(false);
    if (!whitespace.ok) {
      expect(whitespace.response.status).toBe(400);
    }
  });

  it("rejects non-mutating methods and unconfigured origins", async () => {
    const get = await readGuardedMutation(makeRequest({ method: "GET" }), {
      schema,
      config,
    });
    expect(get.ok).toBe(false);
    if (!get.ok) {
      expect(get.response.status).toBe(405);
      expect((await errorBody(get.response)).error.code).toBe("method-not-allowed");
      expect(get.response.headers.get("allow")).toBe("POST, PUT, PATCH, DELETE");
    }

    const badLimit = await readGuardedMutation(makeRequest({ body: "{}" }), {
      schema,
      config,
      maxBytes: 0,
    });
    expect(badLimit.ok).toBe(false);
    if (!badLimit.ok) {
      expect(badLimit.response.status).toBe(500);
    }

    const misconfigured = await readGuardedMutation(makeRequest({ body: "{}" }), {
      schema,
      env: { APP_ORIGIN: "http://evil.example:3000" },
    });
    expect(misconfigured.ok).toBe(false);
    if (!misconfigured.ok) {
      expect(misconfigured.response.status).toBe(500);
      expect((await errorBody(misconfigured.response)).error.code).toBe(
        "server-misconfigured",
      );
    }
  });

  it("exposes a stable per-process CSRF token and a read-only boundary check", async () => {
    const first = getCsrfToken();
    expect(first).toBe(getCsrfToken());
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(verifyCsrfToken(first)).toBe(true);
    expect(verifyCsrfToken("wrong")).toBe(false);
    expect(verifyCsrfToken(null)).toBe(false);

    expect(checkRequestBoundary(makeRequest({ method: "GET" }), { config }).ok).toBe(
      true,
    );
    const crossOrigin = checkRequestBoundary(
      makeRequest({ method: "GET", origin: "http://evil.example:3000" }),
      { config },
    );
    expect(crossOrigin.ok).toBe(false);
    if (!crossOrigin.ok) {
      expect(crossOrigin.response.status).toBe(403);
    }
    expect(DEFAULT_MAX_MUTATION_BODY_BYTES).toBe(64 * 1024);
  });
});
