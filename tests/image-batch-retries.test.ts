import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitImageBatch,
  startImageBatch,
} from "../src/server/image-batch";
import {
  requestImageJobStop,
  resetAdmittedImageJobsForTests,
  startImageJob,
  PAID_JOB_LOCK_SEGMENTS,
} from "../src/server/image-job";
import {
  appendStartedAttempt,
  loadImageJob,
  loadImageManifest,
  PRODUCT_IDS,
  publishAttempt,
  saveImageManifest,
} from "../src/server/image-state";
import { prepareImageQuote } from "../src/server/image-quote";
import { buildAttemptFilename, validateImageBytes } from "../src/server/image-validation";
import { readLockMetadata } from "../src/server/lock";
import { DEFAULT_IMAGE_MODEL_ID } from "../src/server/model-settings";
import { resetPaidOperationsForTests } from "../src/server/paid-operation";
import { Storage } from "../src/server/storage";
import type { ImageModelSelection } from "../src/lib/schemas";
import { attemptId, pngBytes } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const servers: Server[] = [];
const requests: Array<{ method: string; path: string }> = [];
const originalEnv = { ...process.env };

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-retries-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function successPayload(cost?: number): unknown {
  return {
    data: [
      {
        b64_json: pngBytes(32, 32).toString("base64"),
        media_type: "image/png",
      },
    ],
    ...(cost === undefined ? {} : { usage: { cost } }),
  };
}

async function startMock(
  image: (response: ServerResponse) => void,
): Promise<Record<string, string>> {
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
    if (path === "/api/v1/images") {
      image(response);
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
  return {
    LAB_TEST_MODE: "1",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
    DATA_DIR: "/tmp/ai-browser-lab-retries-test-data",
  };
}

async function seedValidImages(storage: Storage, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const productId = PRODUCT_IDS[index];
    if (!productId) throw new Error("Missing product fixture.");
    const id = attemptId(500 + index);
    let manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, productId, id, {
      startedAt: new Date(Date.now() - 5000),
    });
    const filename = buildAttemptFilename(productId, id, "png");
    const bytes = pngBytes(32, 32);
    await storage.writeFile(["images", filename], bytes);
    manifest = publishAttempt(manifest, productId, id, {
      filename,
      validation: validateImageBytes(bytes, { filename }),
      publishedAt: new Date(),
      finishedAt: new Date(),
    });
    await saveImageManifest(storage, manifest);
  }
}

async function admitSingleTarget(
  storage: Storage,
  env: Record<string, string>,
  selection?: ImageModelSelection,
): Promise<string> {
  const selectedIds = ["P24"];
  const quote = await prepareImageQuote({
    storage,
    apiKey: "sk-or-v1-retry-key",
    selectedIds,
    selection,
    env,
  });
  const result = await startImageJob({
    storage,
    apiKey: "sk-or-v1-retry-key",
    fingerprint: quote.fingerprint,
    selectedIds,
    selection,
    env,
  });
  if (result.status !== "started") throw new Error(`Admission failed: ${result.status}`);
  return result.job.jobId;
}

function imagePostCount(): number {
  return requests.filter(
    (request) => request.method === "POST" && request.path === "/api/v1/images",
  ).length;
}

interface SleepCapture {
  readonly delays: number[];
  readonly sleepImpl: (ms: number) => Promise<void>;
}

function sleepCapture(onSleep?: (index: number) => Promise<void> | void): SleepCapture {
  const delays: number[] = [];
  return {
    delays,
    sleepImpl: async (ms: number) => {
      const index = delays.length;
      delays.push(ms);
      if (onSleep) await onSleep(index);
    },
  };
}

afterEach(async () => {
  await resetAdmittedImageJobsForTests();
  resetPaidOperationsForTests();
  requests.length = 0;
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

describe("classified image retries", () => {
  it("retries transient 5xx twice with capped exponential backoff", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    let attempts = 0;
    const env = await startMock((response) => {
      attempts += 1;
      json(response, attempts < 3 ? 502 : 200, attempts < 3 ? { error: {} } : successPayload(0.008));
    });
    const jobId = await admitSingleTarget(storage, env);
    const sleep = sleepCapture();

    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      sleepImpl: sleep.sleepImpl,
    });
    await awaitImageBatch(storage);

    expect(imagePostCount()).toBe(3);
    expect(attempts).toBe(3);
    expect(sleep.delays).toEqual([500, 1000]);
    const job = await loadImageJob(storage);
    expect(job?.status).toBe("completed");
    const ledger = (await loadImageManifest(storage)).products.P24?.attempts ?? [];
    expect(ledger).toHaveLength(3);
    expect(ledger[0]).toMatchObject({ status: "failed", cost: { kind: "unknown" } });
    expect(ledger[1]).toMatchObject({ status: "failed", cost: { kind: "unknown" } });
    expect(ledger[2]).toMatchObject({
      status: "succeeded",
      cost: { kind: "reported", usd: 0.008 },
    });
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  });

  it("honours a bounded Retry-After and otherwise uses backoff", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    let attempts = 0;
    const env = await startMock((response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
        response.end(JSON.stringify({ error: {} }));
        return;
      }
      if (attempts === 2) {
        json(response, 429, { error: {} });
        return;
      }
      json(response, 200, successPayload());
    });
    const jobId = await admitSingleTarget(storage, env);
    const sleep = sleepCapture();

    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      sleepImpl: sleep.sleepImpl,
    });
    await awaitImageBatch(storage);

    expect(sleep.delays).toEqual([2000, 1000]);
    expect(imagePostCount()).toBe(3);
    const ledger = (await loadImageManifest(storage)).products.P24?.attempts ?? [];
    expect(ledger[2]?.cost).toEqual({ kind: "estimated", usd: 0.008 });
  });

  it("caps Retry-After and custom policy delays", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    let attempts = 0;
    const env = await startMock((response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "9999" });
        response.end(JSON.stringify({ error: {} }));
        return;
      }
      json(response, 200, successPayload());
    });
    const jobId = await admitSingleTarget(storage, env);
    const sleep = sleepCapture();
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      retry: { baseDelayMs: 100, maxDelayMs: 300 },
      sleepImpl: sleep.sleepImpl,
    });
    await awaitImageBatch(storage);
    expect(sleep.delays).toEqual([300]);
    expect(imagePostCount()).toBe(2);
  });

  it("never retries 401 or 402", async () => {
    for (const status of [401, 402]) {
      const storage = await makeStorage();
      const env = await startMock((response) => {
        json(response, status, { error: {} });
      });
      const jobId = await admitSingleTarget(storage, env);
      const sleep = sleepCapture();
      await startImageBatch({
        storage,
        jobId,
        apiKey: "sk-or-v1-retry-key",
        env,
        sleepImpl: sleep.sleepImpl,
      });
      await awaitImageBatch(storage);
      expect(imagePostCount(), String(status)).toBe(1);
      expect(sleep.delays, String(status)).toEqual([]);
      expect((await loadImageJob(storage))?.status, String(status)).toBe("failed");
      await resetAdmittedImageJobsForTests();
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      requests.length = 0;
    }
  });

  it("exhausts exactly two retries on persistent network failures", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const env = await startMock((response) => {
      response.destroy();
    });
    const jobId = await admitSingleTarget(storage, env);
    const sleep = sleepCapture();
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      sleepImpl: sleep.sleepImpl,
    });
    await awaitImageBatch(storage);

    expect(imagePostCount()).toBe(3);
    expect(sleep.delays).toEqual([500, 1000]);
    const ledger = (await loadImageManifest(storage)).products.P24?.attempts ?? [];
    expect(ledger).toHaveLength(3);
    expect(ledger.every((attempt) => attempt.cost.kind === "unknown")).toBe(true);
    const job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(job?.targets[0]?.status).toBe("failed");
  });

  it("sends no retry when a stop lands during backoff", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const env = await startMock((response) => {
      json(response, 503, { error: {} });
    });
    const jobId = await admitSingleTarget(storage, env);
    const sleep = sleepCapture(async () => {
      await requestImageJobStop({ storage, jobId });
    });

    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      sleepImpl: sleep.sleepImpl,
    });
    await awaitImageBatch(storage);

    expect(imagePostCount()).toBe(1);
    expect(sleep.delays).toEqual([500]);
    const job = await loadImageJob(storage);
    expect(job?.status).toBe("stopped_by_user");
    expect(job?.stopRequest?.jobId).toBe(jobId);
    expect(job?.targets[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("provider returned an error"),
    });
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  });

  it("stops the batch on 403 and on a deterministic format mismatch", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const forbidden = await startMock((response) => {
      json(response, 403, { error: {} });
    });
    const forbiddenJob = await admitSingleTarget(storage, forbidden);
    const forbiddenSleep = sleepCapture();
    await startImageBatch({
      storage,
      jobId: forbiddenJob,
      apiKey: "sk-or-v1-retry-key",
      env: forbidden,
      sleepImpl: forbiddenSleep.sleepImpl,
    });
    await awaitImageBatch(storage);
    expect(imagePostCount()).toBe(1);
    expect(forbiddenSleep.delays).toEqual([]);
    expect((await loadImageJob(storage))?.status).toBe("failed");

    await resetAdmittedImageJobsForTests();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    requests.length = 0;

    const storage2 = await makeStorage();
    await seedValidImages(storage2, 23);
    const mismatch = await startMock((response) => {
      json(response, 200, successPayload(0.008));
    });
    const mismatchJob = await admitSingleTarget(storage2, mismatch, {
      modelId: DEFAULT_IMAGE_MODEL_ID,
      resolution: "768",
      aspectRatio: "1:1",
      format: "webp",
      n: 1,
    });
    const mismatchSleep = sleepCapture();
    await startImageBatch({
      storage: storage2,
      jobId: mismatchJob,
      apiKey: "sk-or-v1-retry-key",
      env: mismatch,
      sleepImpl: mismatchSleep.sleepImpl,
    });
    await awaitImageBatch(storage2);
    expect(imagePostCount()).toBe(1);
    expect(mismatchSleep.delays).toEqual([]);
    const mismatchJobState = await loadImageJob(storage2);
    expect(mismatchJobState?.status).toBe("failed");
    expect(mismatchJobState?.error).toMatch(/format-mismatch/);
  }, 30_000);

  it("retries timeouts, honours Retry-After on 5xx, and parses HTTP dates", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    let attemptCount = 0;
    const env = await startMock((response) => {
      attemptCount += 1;
      if (attemptCount < 3) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"data":');
        setTimeout(() => response.end("[]}"), 200);
        return;
      }
      json(response, 200, successPayload());
    });
    const jobId = await admitSingleTarget(storage, env);
    const sleep = sleepCapture();
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      timeoutMs: 30,
      sleepImpl: sleep.sleepImpl,
    });
    await awaitImageBatch(storage);
    expect(imagePostCount()).toBe(3);
    expect(sleep.delays).toEqual([500, 1000]);
    const ledger = (await loadImageManifest(storage)).products.P24?.attempts ?? [];
    expect(ledger[0]?.error).toMatch(/timed out/);
    expect(ledger[0]?.error).not.toMatch(/not retried/);

    const storage2 = await makeStorage();
    await seedValidImages(storage2, 23);
    let second = 0;
    const fiveXx = await startMock((response) => {
      second += 1;
      if (second === 1) {
        response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
        response.end(JSON.stringify({ error: {} }));
        return;
      }
      json(response, 200, successPayload());
    });
    const jobId2 = await admitSingleTarget(storage2, fiveXx);
    const sleep2 = sleepCapture();
    await startImageBatch({
      storage: storage2,
      jobId: jobId2,
      apiKey: "sk-or-v1-retry-key",
      env: fiveXx,
      sleepImpl: sleep2.sleepImpl,
    });
    await awaitImageBatch(storage2);
    expect(sleep2.delays).toEqual([1000]);

    const storage3 = await makeStorage();
    await seedValidImages(storage3, 23);
    let third = 0;
    const dateHeader = await startMock((response) => {
      third += 1;
      if (third === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": new Date(Date.now() + 2000).toUTCString(),
        });
        response.end(JSON.stringify({ error: {} }));
        return;
      }
      json(response, 200, successPayload());
    });
    const jobId3 = await admitSingleTarget(storage3, dateHeader);
    const sleep3 = sleepCapture();
    await startImageBatch({
      storage: storage3,
      jobId: jobId3,
      apiKey: "sk-or-v1-retry-key",
      env: dateHeader,
      sleepImpl: sleep3.sleepImpl,
    });
    await awaitImageBatch(storage3);
    expect(sleep3.delays).toHaveLength(1);
    expect(sleep3.delays[0]).toBeGreaterThanOrEqual(1900);
    expect(sleep3.delays[0]).toBeLessThanOrEqual(2000);
  }, 30_000);

  it("rejects invalid retry policy before sending requests", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const env = await startMock((response) => {
      json(response, 200, successPayload());
    });
    const jobId = await admitSingleTarget(storage, env);
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      retry: { baseDelayMs: -1 },
    });
    await awaitImageBatch(storage);
    expect(imagePostCount()).toBe(0);
    const job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  });

  it("honours maxRetries: 0 for a single attempt", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const env = await startMock((response) => {
      json(response, 500, { error: {} });
    });
    const jobId = await admitSingleTarget(storage, env);
    const sleep = sleepCapture();
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-retry-key",
      env,
      retry: { maxRetries: 0 },
      sleepImpl: sleep.sleepImpl,
    });
    await awaitImageBatch(storage);
    expect(imagePostCount()).toBe(1);
    expect(sleep.delays).toEqual([]);
    expect((await loadImageJob(storage))?.status).toBe("failed");
  });
});
