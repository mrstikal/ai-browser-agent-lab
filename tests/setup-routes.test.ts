import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as confirmRoute from "@/app/api/setup/confirm/route";
import * as keyRoute from "@/app/api/setup/key/route";
import * as modelsRoute from "@/app/api/setup/models/route";
import {
  DEFAULT_IMAGE_MODEL_ID,
  loadModelSettings,
} from "@/server/model-settings";
import {
  resetCredentialHolderForTests,
} from "@/server/credentials";
import {
  beginPaidOperation,
  endPaidOperation,
  resetPaidOperationsForTests,
} from "@/server/paid-operation";
import { Storage } from "@/server/storage";

const tempDirs: string[] = [];
let server: Server;
let baseUrl: string;
let keyStatus = 200;
let keyBody: unknown = { data: { is_management_key: false } };
const requests: Array<{ method: string; path: string }> = [];
const originalEnv = { ...process.env };

async function makeDataDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-setup-routes-"));
  tempDirs.push(base);
  return join(base, "data");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const path = request.url ?? "";
  requests.push({ method: request.method ?? "", path });
  if (path === "/api/v1/key") {
    json(response, keyStatus, keyBody);
    return;
  }
  if (path === "/api/v1/images/models") {
    json(response, 200, {
      data: [
        {
          id: DEFAULT_IMAGE_MODEL_ID,
          architecture: { output_modalities: ["image"] },
        },
      ],
    });
    return;
  }
  if (path.includes("/images/models/") && path.endsWith("/endpoints")) {
    json(response, 200, {
      id: DEFAULT_IMAGE_MODEL_ID,
      endpoints: [
        {
          provider_slug: "cheap",
          provider_tag: "cheap",
          supports_streaming: false,
          allowed_passthrough_parameters: [],
          supported_parameters: {
            resolution: { type: "enum", values: ["768"] },
            aspect_ratio: { type: "enum", values: ["1:1"] },
            output_format: { type: "enum", values: ["png", "jpeg", "webp"] },
            n: { type: "range", min: 1, max: 1 },
          },
          pricing: [
            { billable: "output_image", unit: "image", cost_usd: 0.008, variant: "768" },
          ],
        },
      ],
    });
    return;
  }
  json(response, 404, { error: { message: "Resource not found" } });
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  options: { readonly origin?: string | null; readonly host?: string } = {},
): Request {
  const headers = new Headers();
  headers.set("host", options.host ?? "127.0.0.1:3000");
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "http://127.0.0.1:3000");
  }
  headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = { ...originalEnv };
});

beforeEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  requests.length = 0;
  keyStatus = 200;
  keyBody = { data: { is_management_key: false } };
  process.env.DATA_DIR = await makeDataDir();
  process.env.LAB_TEST_MODE = "1";
  process.env.OPENROUTER_BASE_URL = baseUrl;
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("setup key route", () => {
  it("rejects invalid credentials without storing anything", async () => {
    keyStatus = 401;
    const response = await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", { key: "sk-or-v1-bad", remember: false }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "invalid-key" } });
    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();
  });

  it("validates and stores memory and remembered keys without echoing the secret", async () => {
    const memory = await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", {
        key: "sk-or-v1-session-key",
        remember: false,
      }),
    );
    expect(memory.status).toBe(200);
    const memoryBody = (await memory.json()) as Record<string, unknown>;
    expect(memoryBody).toEqual({
      keyAvailable: true,
      source: "memory",
      managementOnly: false,
      inferenceAccess: "unverified",
    });
    expect(JSON.stringify(memoryBody)).not.toContain("sk-or-v1-session-key");

    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();

    const remembered = await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", {
        key: "sk-or-v1-remembered-key",
        remember: true,
      }),
    );
    expect(remembered.status).toBe(200);
    expect(await storage.readFile(["secrets", "openrouter-key"])).toEqual(
      Buffer.from("sk-or-v1-remembered-key"),
    );
    if (process.platform !== "win32") {
      expect(
        (await stat(storage.path(["secrets", "openrouter-key"]))).mode & 0o777,
      ).toBe(0o600);
    }

    const memoryAgain = await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", {
        key: "sk-or-v1-replacement",
        remember: false,
      }),
    );
    expect(memoryAgain.status).toBe(200);
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();

    const deleted = await keyRoute.DELETE(makeRequest("DELETE", "/api/setup/key", {}));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ keyAvailable: false, source: null });
  });

  it("flags management-only keys but still reports them as valid", async () => {
    keyBody = { data: { is_management_key: true } };
    const response = await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", { key: "sk-or-v1-mgmt", remember: false }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      keyAvailable: true,
      managementOnly: true,
      inferenceAccess: "unverified",
    });
  });

  it("enforces the Phase 9 guard and body limits before touching the key", async () => {
    const crossOrigin = await keyRoute.POST(
      makeRequest(
        "POST",
        "/api/setup/key",
        { key: "sk-or-v1-cross", remember: false },
        { origin: "http://evil.example:3000" },
      ),
    );
    expect(crossOrigin.status).toBe(403);
    expect(requests).toEqual([]);

    const malformed = await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", { key: 123, remember: "yes" }),
    );
    expect(malformed.status).toBe(422);
    expect(requests).toEqual([]);
  });
});

describe("setup models route", () => {
  it("stores image and browser choices independently", async () => {
    const image = await modelsRoute.POST(
      makeRequest("POST", "/api/setup/models", {
        image: {
          modelId: "other/model-v1",
          resolution: "1K",
          aspectRatio: "4:3",
          format: "webp",
          n: 1,
        },
      }),
    );
    expect(image.status).toBe(200);

    const storage = new Storage(process.env.DATA_DIR ?? "");
    const afterImage = await loadModelSettings(storage);
    expect(afterImage.image.modelId).toBe("other/model-v1");
    expect(afterImage.browser.modelId).toBe("openrouter/openai/gpt-5.6-luna");

    const browser = await modelsRoute.POST(
      makeRequest("POST", "/api/setup/models", {
        browser: { modelId: "openrouter/openai/advanced:free-1" },
      }),
    );
    expect(browser.status).toBe(200);
    const afterBrowser = await loadModelSettings(storage);
    expect(afterBrowser.image.modelId).toBe("other/model-v1");
    expect(afterBrowser.browser.modelId).toBe("openrouter/openai/advanced:free-1");
    expect(JSON.stringify(await browser.json())).not.toContain("key");

    const invalid = await modelsRoute.POST(
      makeRequest("POST", "/api/setup/models", {
        browser: { modelId: "no-slash" },
      }),
    );
    expect(invalid.status).toBe(422);
  });
});

describe("setup confirm route", () => {
  it("requires a validated key", async () => {
    const response = await confirmRoute.POST(
      makeRequest("POST", "/api/setup/confirm", {
        confirm: true,
        fingerprint: "a".repeat(64),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "key-required" } });
    expect(requests).toEqual([]);
  });

  it("confirms the displayed quote fingerprint without starting paid work", async () => {
    await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", {
        key: "sk-or-v1-confirm-key",
        remember: false,
      }),
    );
    requests.length = 0;

    const wrong = await confirmRoute.POST(
      makeRequest("POST", "/api/setup/confirm", {
        confirm: true,
        fingerprint: "0".repeat(64),
      }),
    );
    expect(wrong.status).toBe(409);
    const wrongBody = (await wrong.json()) as {
      error: { code: string };
      quote: { fingerprint: string };
    };
    expect(wrongBody.error.code).toBe("quote-changed");
    expect(wrongBody.quote.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const response = await confirmRoute.POST(
      makeRequest("POST", "/api/setup/confirm", {
        confirm: true,
        fingerprint: wrongBody.quote.fingerprint,
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      started: boolean;
      acceptedFingerprint: string;
      quote: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.started).toBe(false);
    expect(body.acceptedFingerprint).toBe(wrongBody.quote.fingerprint);
    expect(body.quote).toMatchObject({
      baseUsd: "0.192",
      startingBalanceBaseUsd: "1.184",
      providerSlug: "cheap",
      providerOnly: ["cheap"],
    });
    expect(JSON.stringify(body)).not.toContain("sk-or-v1-confirm-key");
    expect(requests.every((request) => request.method === "GET")).toBe(true);

    beginPaidOperation("image-job-1", "image");
    const duringPaid = await confirmRoute.POST(
      makeRequest("POST", "/api/setup/confirm", {
        confirm: true,
        fingerprint: wrongBody.quote.fingerprint,
      }),
    );
    expect(duringPaid.status).toBe(409);
    expect(await duringPaid.json()).toMatchObject({
      error: { code: "paid-operation-active" },
    });
    endPaidOperation("image-job-1");
  });

  it("rejects stale model choices and guard violations", async () => {
    await keyRoute.POST(
      makeRequest("POST", "/api/setup/key", {
        key: "sk-or-v1-stale-key",
        remember: false,
      }),
    );
    await modelsRoute.POST(
      makeRequest("POST", "/api/setup/models", {
        image: {
          modelId: "gone/model",
          resolution: "768",
          aspectRatio: "1:1",
          format: "png",
          n: 1,
        },
      }),
    );

    const stale = await confirmRoute.POST(
      makeRequest("POST", "/api/setup/confirm", {
        confirm: true,
        fingerprint: "a".repeat(64),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale-model" } });

    const crossOrigin = await confirmRoute.POST(
      makeRequest(
        "POST",
        "/api/setup/confirm",
        { confirm: true, fingerprint: "a".repeat(64) },
        { origin: "http://evil.example:3000" },
      ),
    );
    expect(crossOrigin.status).toBe(403);
  });
});
