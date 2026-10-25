import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as keyRoute from "@/app/api/setup/key/route";
import * as modelsRoute from "@/app/api/setup/models/route";
import {
  DEFAULT_BROWSER_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  loadModelSettings,
} from "@/server/model-settings";
import {
  loadAgentCompatibility,
  saveAgentCompatibility,
} from "@/server/agent-compatibility";
import {
  resetCredentialHolderForTests,
} from "@/server/credentials";
import {
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
      keyPermitsInference: true,
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
      keyPermitsInference: false,
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

  it("keeps the compatibility stamp when unreadable settings abort a browser change", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    await saveAgentCompatibility(storage, {
      version: 1,
      modelId: DEFAULT_BROWSER_MODEL_ID,
      sdkVersion: "0.1.0",
      origin: "http://127.0.0.1:3000",
      verifiedAt: new Date().toISOString(),
      vision: "unverified",
    });
    await storage.writeFile(["settings.json"], "{not json");

    const response = await modelsRoute.POST(
      makeRequest("POST", "/api/setup/models", {
        browser: { modelId: "openrouter/openai/advanced:free-1" },
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "settings-corrupt" },
    });
    expect(await loadAgentCompatibility(storage)).toBeDefined();
  });
});
