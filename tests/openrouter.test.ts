import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  isDisposableTestDataDir,
  isTemporaryDataDir,
  normalizeOpenRouterKey,
  openRouterEndpoint,
  OpenRouterConfigError,
  OpenRouterKeyFormatError,
  resolveOpenRouterBaseUrl,
  validateOpenRouterKey,
} from "../src/server/openrouter";
import type { StorageEnv } from "../src/server/storage";

const servers: Server[] = [];
const tempDataDir = join(tmpdir(), "ai-browser-lab-openrouter-test-data");

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startMock(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; env: StorageEnv; server: Server }> {
  const server = createServer(respond);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  return {
    baseUrl,
    server,
    env: {
      LAB_TEST_MODE: "1",
      OPENROUTER_BASE_URL: baseUrl,
      DATA_DIR: tempDataDir,
    },
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("OpenRouter base URL resolver", () => {
  it("defaults to the fixed production API base", () => {
    expect(resolveOpenRouterBaseUrl({})).toBe(DEFAULT_OPENROUTER_BASE_URL);
    expect(DEFAULT_OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("allows a loopback override only in explicit test mode with a temporary DATA_DIR", async () => {
    const { baseUrl, env } = await startMock((_request, response) => json(response, 200, { data: {} }));
    expect(resolveOpenRouterBaseUrl(env)).toBe(baseUrl);
    expect(isTemporaryDataDir(tempDataDir)).toBe(true);
    expect(isDisposableTestDataDir(tempDataDir)).toBe(true);
    expect(() =>
      resolveOpenRouterBaseUrl({ LAB_TEST_MODE: "1", OPENROUTER_BASE_URL: baseUrl }),
    ).toThrow(/DATA_DIR/);
    expect(() =>
      resolveOpenRouterBaseUrl({ OPENROUTER_BASE_URL: baseUrl, DATA_DIR: tempDataDir }),
    ).toThrow(/LAB_TEST_MODE/);
    expect(() =>
      resolveOpenRouterBaseUrl({
        LAB_TEST_MODE: "1",
        DATA_DIR: tempDataDir,
        OPENROUTER_BASE_URL: "http://192.168.1.10:4311/api/v1",
      }),
    ).toThrow(/loopback/);
    expect(() =>
      resolveOpenRouterBaseUrl({
        LAB_TEST_MODE: "1",
        DATA_DIR: tempDataDir,
        OPENROUTER_BASE_URL: "http://127.0.0.1/api/v1",
      }),
    ).toThrow(/explicit port/);
    expect(() =>
      resolveOpenRouterBaseUrl({
        LAB_TEST_MODE: "1",
        DATA_DIR: tempDataDir,
        OPENROUTER_BASE_URL: "http://user:pass@127.0.0.1:4311/api/v1",
      }),
    ).toThrow(/credentials/);
    expect(() =>
      resolveOpenRouterBaseUrl({
        LAB_TEST_MODE: "1",
        DATA_DIR: tempDataDir,
        OPENROUTER_BASE_URL: "http://127.0.0.1:4311/api/v1?x=1",
      }),
    ).toThrow(/query or fragment/);
    expect(
      resolveOpenRouterBaseUrl({
        LAB_TEST_MODE: "1",
        DATA_DIR: tempDataDir,
        OPENROUTER_BASE_URL: "http://127.0.0.1:4311/api/v1/",
      }),
    ).toBe("http://127.0.0.1:4311/api/v1");
  });

  it("rejects a mock override when DATA_DIR is the real project data directory", async () => {
    const { baseUrl } = await startMock((_request, response) =>
      json(response, 200, { data: {} }),
    );
    expect(isDisposableTestDataDir(join(process.cwd(), "data"))).toBe(false);
    expect(() =>
      resolveOpenRouterBaseUrl({
        LAB_TEST_MODE: "1",
        DATA_DIR: join(process.cwd(), "data"),
        OPENROUTER_BASE_URL: baseUrl,
      }),
    ).toThrow(/temporary DATA_DIR/);
    expect(() =>
      resolveOpenRouterBaseUrl({
        LAB_TEST_MODE: "1",
        DATA_DIR: join(tmpdir(), "..", "ai-browser-lab-outside-temp"),
        OPENROUTER_BASE_URL: baseUrl,
      }),
    ).toThrow(/temporary DATA_DIR/);
  });

  it("rejects the project data directory even when the repository is below a temp root", async () => {
    const { baseUrl } = await startMock((_request, response) =>
      json(response, 200, { data: {} }),
    );
    const fakeRepo = join(tmpdir(), "ai-browser-lab-fake-repo");
    const fakeRepoData = join(fakeRepo, "data");
    expect(isTemporaryDataDir(fakeRepoData)).toBe(true);
    expect(isDisposableTestDataDir(fakeRepoData, fakeRepo)).toBe(false);
    expect(isDisposableTestDataDir(fakeRepo, fakeRepo)).toBe(false);
    expect(
      isDisposableTestDataDir(join(tmpdir(), "ai-browser-lab-e2e-data"), fakeRepo),
    ).toBe(true);
    expect(() =>
      resolveOpenRouterBaseUrl(
        {
          LAB_TEST_MODE: "1",
          DATA_DIR: fakeRepoData,
          OPENROUTER_BASE_URL: baseUrl,
        },
        fakeRepo,
      ),
    ).toThrow(/outside the project directory/);
  });

  it("builds endpoint URLs and rejects malformed keys", () => {
    expect(openRouterEndpoint("https://openrouter.ai/api/v1/", "/key")).toBe(
      "https://openrouter.ai/api/v1/key",
    );
    expect(() => openRouterEndpoint("https://openrouter.ai/api/v1", "")).toThrow(
      OpenRouterConfigError,
    );

    expect(normalizeOpenRouterKey("  sk-or-v1-abc123  ")).toBe("sk-or-v1-abc123");
    for (const bad of [
      "short",
      "x".repeat(600),
      "sk-or v1 abc",
      "sk-or-v1-abc\u0000def",
    ]) {
      expect(() => normalizeOpenRouterKey(bad)).toThrow(OpenRouterKeyFormatError);
    }
  });
});

describe("OpenRouter key validation", () => {
  it("treats 200 with data as valid and never returns raw metadata", async () => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const { env } = await startMock((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      json(response, 200, {
        data: { label: "production-key-label", usage: 12.5, limit: 50 },
      });
    });

    const result = await validateOpenRouterKey("sk-or-v1-test-key", { env });
    expect(result).toEqual({
      status: "valid",
      managementOnly: false,
      inferenceAccess: "unverified",
      httpStatus: 200,
      reason: null,
    });
    expect(requests).toEqual([
      { url: "/api/v1/key", authorization: "Bearer sk-or-v1-test-key" },
    ]);
    expect(JSON.stringify(result)).not.toContain("production-key-label");
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-test-key");
  });

  it("flags management-only keys without claiming inference access", async () => {
    const { env } = await startMock((_request, response) =>
      json(response, 200, { data: { is_management_key: true, label: "mgmt" } }),
    );
    const result = await validateOpenRouterKey("sk-or-v1-management", { env });
    expect(result).toMatchObject({
      status: "valid",
      managementOnly: true,
      inferenceAccess: "unverified",
    });

    const provisioning = await startMock((_request, response) =>
      json(response, 200, { data: { is_provisioning_key: true } }),
    );
    expect(
      await validateOpenRouterKey("sk-or-v1-provisioning", { env: provisioning.env }),
    ).toMatchObject({ status: "valid", managementOnly: true });
  });

  it("requires a strict HTTP 200 for key validation", async () => {
    const accepted = await startMock((_request, response) =>
      json(response, 202, { data: { label: "accepted" } }),
    );
    expect(
      await validateOpenRouterKey("sk-or-v1-accepted", {
        env: accepted.env,
      }),
    ).toMatchObject({ status: "invalid-response", httpStatus: 202 });

    const created = await startMock((_request, response) =>
      json(response, 201, { data: {} }),
    );
    expect(
      await validateOpenRouterKey("sk-or-v1-created", { env: created.env }),
    ).toMatchObject({ status: "invalid-response", httpStatus: 201 });
  });

  it("distinguishes 401, other 4xx, 5xx, network, and timeout failures", async () => {
    const unauthorized = await startMock((_request, response) => {
      json(response, 401, { error: { message: "Invalid credentials" } });
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-invalid", { env: unauthorized.env }),
    ).toEqual({
      status: "invalid",
      managementOnly: false,
      inferenceAccess: "unverified",
      httpStatus: 401,
      reason: null,
    });

    const forbidden = await startMock((_request, response) => {
      json(response, 403, { error: { message: "Forbidden" } });
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-forbidden", { env: forbidden.env }),
    ).toMatchObject({ status: "unavailable", httpStatus: 403 });

    const rateLimited = await startMock((_request, response) => {
      json(response, 429, { error: { message: "Too many requests" } });
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-limited", { env: rateLimited.env }),
    ).toMatchObject({ status: "unavailable", httpStatus: 429 });

    const failing = await startMock((_request, response) => {
      json(response, 502, { error: { message: "Bad gateway" } });
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-5xx", { env: failing.env }),
    ).toMatchObject({ status: "unavailable", httpStatus: 502 });

    const unreachable = await startMock((_request, response) =>
      json(response, 200, { data: {} }),
    );
    await closeServer(unreachable.server);
    expect(
      await validateOpenRouterKey("sk-or-v1-network", { env: unreachable.env }),
    ).toMatchObject({ status: "unavailable", reason: "network", httpStatus: null });

    const slow = await startMock((_request, response) => {
      setTimeout(() => json(response, 200, { data: {} }), 300);
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-timeout", {
        env: slow.env,
        timeoutMs: 30,
      }),
    ).toMatchObject({ status: "unavailable", reason: "timeout" });
  });

  it("keeps the timeout through the body read", async () => {
    const slowBody = await startMock((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":');
      // Keep a wide margin over the 30 ms client timeout so event-loop load
      // cannot make the body finish first.
      setTimeout(() => response.end("{}}"), 600);
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-slow-body", {
        env: slowBody.env,
        timeoutMs: 30,
      }),
    ).toMatchObject({ status: "unavailable", reason: "timeout" });
  });

  it("treats a mid-body stream failure as a network failure", async () => {
    const brokenBody = await startMock((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":');
      response.destroy();
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-broken-body", {
        env: brokenBody.env,
      }),
    ).toMatchObject({ status: "unavailable", reason: "network" });
  });

  it("treats malformed, oversized, and redirected 200 responses as invalid responses", async () => {
    const notJson = await startMock((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json");
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-malformed", { env: notJson.env }),
    ).toMatchObject({ status: "invalid-response", httpStatus: 200 });

    const noData = await startMock((_request, response) => json(response, 200, { ok: true }));
    expect(
      await validateOpenRouterKey("sk-or-v1-nodata", { env: noData.env }),
    ).toMatchObject({ status: "invalid-response" });

    const arrayData = await startMock((_request, response) =>
      json(response, 200, { data: [1, 2, 3] }),
    );
    expect(
      await validateOpenRouterKey("sk-or-v1-array", { env: arrayData.env }),
    ).toMatchObject({ status: "invalid-response" });

    const oversized = await startMock((_request, response) => {
      json(response, 200, { data: { label: "x".repeat(200) } });
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-oversized", {
        env: oversized.env,
        maxBytes: 32,
      }),
    ).toMatchObject({ status: "invalid-response" });

    const redirect = await startMock((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1:1/api/v1/key" });
      response.end();
    });
    expect(
      await validateOpenRouterKey("sk-or-v1-redirect", { env: redirect.env }),
    ).toMatchObject({ status: "unavailable", reason: "network" });
  });
});
