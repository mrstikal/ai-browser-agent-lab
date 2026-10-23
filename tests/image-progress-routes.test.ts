import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as progressRoute from "@/app/api/images/progress/route";
import * as streamRoute from "@/app/api/images/progress/stream/route";
import * as quoteRoute from "@/app/api/images/quote/route";
import {
  createImageJobSnapshot,
  saveImageJob,
} from "@/server/image-state";
import { resetCredentialHolderForTests, setOpenRouterKey } from "@/server/credentials";
import { resetPaidOperationsForTests } from "@/server/paid-operation";
import { DEFAULT_IMAGE_MODEL_ID } from "@/server/model-settings";
import { readLockMetadata } from "@/server/lock";
import { PAID_JOB_LOCK_SEGMENTS } from "@/server/image-job";
import { Storage } from "@/server/storage";
import { attemptId } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const servers: Server[] = [];
const requests: Array<{ method: string; path: string }> = [];
const originalEnv = { ...process.env };

async function makeDataDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-progress-routes-"));
  tempDirs.push(base);
  return join(base, "data");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startCatalog(): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push({ method: request.method ?? "", path });
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
    json(response, 404, { error: { message: "not found" } });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/v1`;
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): Request {
  const headers = new Headers();
  headers.set("host", "127.0.0.1:3000");
  headers.set("origin", "http://127.0.0.1:3000");
  headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

beforeEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  requests.length = 0;
  const dataDir = await makeDataDir();
  const baseUrl = await startCatalog();
  process.env.DATA_DIR = dataDir;
  process.env.LAB_TEST_MODE = "1";
  process.env.OPENROUTER_BASE_URL = baseUrl;
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
});

afterEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  process.env = { ...originalEnv };
});

describe("progress routes", () => {
  it("returns a no-store snapshot without creating any work", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const job = createImageJobSnapshot({
      jobId: attemptId(1000),
      productIds: ["P01"],
      now: new Date(),
    });
    await saveImageJob(storage, {
      ...job,
      status: "running",
      targets: [
        { productId: "P01", status: "generating", attemptId: null, error: null },
      ],
    });
    const before = await storage.readFile(["images", "manifest.json"]);

    const response = await progressRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      job: { status: string };
      setup: { validImageCount: number };
      preview: unknown[];
    };
    expect(body.job.status).toBe("running");
    expect(body.setup.validImageCount).toBe(0);
    expect(body.preview).toHaveLength(24);
    expect(await storage.readFile(["images", "manifest.json"])).toEqual(before);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  });

  it("streams the first snapshot as SSE and closes on abort", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const job = createImageJobSnapshot({
      jobId: attemptId(1001),
      productIds: ["P01"],
      now: new Date(),
    });
    await saveImageJob(storage, { ...job, status: "running" });

    const controller = new AbortController();
    const response = await streamRoute.GET(
      new Request("http://127.0.0.1:3000/api/images/progress/stream", {
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.body).not.toBeNull();

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing SSE body.");
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain('"status":"running"');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  }, 10_000);

  it("reconnecting the SSE stream never creates work or a second image", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const job = createImageJobSnapshot({
      jobId: attemptId(1002),
      productIds: ["P01"],
      now: new Date(),
    });
    await saveImageJob(storage, { ...job, status: "running" });

    const readFirstSnapshot = async (): Promise<string> => {
      const controller = new AbortController();
      const response = await streamRoute.GET(
        new Request("http://127.0.0.1:3000/api/images/progress/stream", {
          signal: controller.signal,
        }),
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing SSE body.");
      const { value } = await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
      return new TextDecoder().decode(value);
    };

    expect(await readFirstSnapshot()).toContain("event: snapshot");
    expect(await readFirstSnapshot()).toContain("event: snapshot");
    expect(
      await storage.readFile(["images", "manifest.json"]),
    ).toBeUndefined();
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  }, 10_000);

  it("prepares a fresh resume quote without a paid request", async () => {
    await setOpenRouterKey("sk-or-v1-progress-key", {
      remember: false,
      env: process.env,
    });
    requests.length = 0;
    const response = await quoteRoute.POST(
      makeRequest("POST", "/api/images/quote", { selectedIds: ["P01"] }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      quote: { fingerprint: string; baseUsd: string; targets: string[] };
    };
    expect(body.quote.targets).toEqual(["P01"]);
    expect(body.quote.baseUsd).toBe("0.008");
    expect(body.quote.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain("sk-or-v1-progress-key");
    expect(
      requests.some((request) => request.method === "POST"),
    ).toBe(false);

    await resetCredentialHolderForTests();
    const noKey = await quoteRoute.POST(
      makeRequest("POST", "/api/images/quote", { selectedIds: ["P01"] }),
    );
    expect(noKey.status).toBe(409);
    expect(await noKey.json()).toMatchObject({ error: { code: "key-required" } });
  });
});