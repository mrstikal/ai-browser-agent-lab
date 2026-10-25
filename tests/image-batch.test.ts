import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitImageBatch,
  startImageBatch,
  activeImageBatchJobId,
} from "../src/server/image-batch";
import {
  startImageJob,
  resetAdmittedImageJobsForTests,
  PAID_JOB_LOCK_SEGMENTS,
} from "../src/server/image-job";
import {
  appendStartedAttempt,
  inspectSetupState,
  loadImageJob,
  loadImageManifest,
  publishAttempt,
  PRODUCT_IDS,
  saveImageManifest,
} from "../src/server/image-state";
import { prepareImageQuote } from "../src/server/image-quote";
import { buildAttemptFilename, validateImageBytes } from "../src/server/image-validation";
import { readLockMetadata } from "../src/server/lock";
import { DEFAULT_IMAGE_MODEL_ID } from "../src/server/model-settings";
import {
  isPaidOperationActive,
  resetPaidOperationsForTests,
} from "../src/server/paid-operation";
import { Storage } from "../src/server/storage";
import { attemptId, pngBytes } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const servers: Server[] = [];
const requests: Array<{ method: string; path: string }> = [];
const originalEnv = { ...process.env };

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-batch-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function imagePayload(
  bytes: Buffer,
  options: { readonly mediaType?: string; readonly cost?: number } = {},
): unknown {
  return {
    data: [
      {
        b64_json: bytes.toString("base64"),
        media_type: options.mediaType ?? "image/png",
      },
    ],
    usage: { cost: options.cost ?? 0.008 },
  };
}

async function startMock(options: {
  readonly image?: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>;
} = {}): Promise<Record<string, string>> {
  const server = createServer(async (request, response) => {
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
      if (options.image) {
        await options.image(request, response);
        return;
      }
      json(response, 200, imagePayload(pngBytes(32, 32)));
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
    DATA_DIR: "/tmp/ai-browser-lab-batch-test-data",
  };
}

async function admitJob(
  storage: Storage,
  env: Record<string, string>,
  selectedIds?: readonly string[],
): Promise<string> {
  const quote = await prepareImageQuote({
    storage,
    apiKey: "sk-or-v1-batch-key",
    selectedIds,
    env,
  });
  const result = await startImageJob({
    storage,
    apiKey: "sk-or-v1-batch-key",
    fingerprint: quote.fingerprint,
    selectedIds,
    env,
  });
  if (result.status !== "started") {
    throw new Error(`Admission failed: ${result.status}`);
  }
  return result.job.jobId;
}

async function publishValidImage(
  storage: Storage,
  productId: string,
  index: number,
): Promise<string> {
  const id = attemptId(index);
  let manifest = await loadImageManifest(storage);
  manifest = appendStartedAttempt(manifest, productId as never, id, {
    startedAt: new Date(Date.now() - 5000),
  });
  const filename = buildAttemptFilename(productId as never, id, "png");
  const bytes = pngBytes(32, 32);
  await storage.writeFile(["images", filename], bytes);
  manifest = publishAttempt(manifest, productId as never, id, {
    filename,
    validation: await validateImageBytes(bytes, { filename }),
    publishedAt: new Date(),
    finishedAt: new Date(),
  });
  await saveImageManifest(storage, manifest);
  return filename;
}

function imagePostCount(): number {
  return requests.filter(
    (request) => request.method === "POST" && request.path === "/api/v1/images",
  ).length;
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

describe("sequential image batch", () => {
  it("runs a full 24-target mock batch to a completed job and releases the lock", async () => {
    const storage = await makeStorage();
    const env = await startMock();
    const jobId = await admitJob(storage, env);

    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await awaitImageBatch(storage);

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("completed");
    expect(job?.targets.every((target) => target.status === "succeeded")).toBe(true);
    expect(imagePostCount()).toBe(24);
    expect(imagePostCount()).toBe(job?.targets.length);
    expect(requests.every((request) => request.method !== "PUT")).toBe(true);

    const manifest = await loadImageManifest(storage);
    const filenames = new Set(
      PRODUCT_IDS.map((productId) => manifest.products[productId]?.active?.filename),
    );
    expect(filenames.size).toBe(24);
    expect(activeImageBatchJobId(storage)).toBeNull();
    expect(isPaidOperationActive()).toBe(false);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
    expect(
      (await readdir(storage.path(["images"]))).filter((name) =>
        name.endsWith(".png"),
      ),
    ).toHaveLength(24);
    expect(
      (await inspectSetupState(storage, { keyAvailable: true })).status,
    ).toBe("completed");
  });

  it("persists the cause of an unexpected batch failure", async () => {
    const storage = await makeStorage();
    const env = await startMock();
    const jobId = await admitJob(storage, env, ["P01"]);

    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
      retry: { baseDelayMs: 0 },
    });

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("baseDelayMs must be a positive integer");
    expect(imagePostCount()).toBe(0);
    expect(isPaidOperationActive()).toBe(false);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  });

  it("stops after the in-flight request settles and sends no next request", async () => {
    const storage = await makeStorage();
    let notifyStarted: (() => void) | null = null;
    const gate: { release: (() => void) | null } = { release: null };
    const firstImageStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const env = await startMock({
      image: (_request, response) =>
        new Promise<void>((resolve) => {
          notifyStarted?.();
          notifyStarted = null;
          gate.release = () => {
            json(response, 200, imagePayload(pngBytes(32, 32)));
            resolve();
          };
        }),
    });
    const jobId = await admitJob(storage, env);

    const batch = startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await firstImageStarted;
    await requestStop(storage, jobId);
    const release = gate.release as (() => void) | null;
    if (!release) throw new Error("Image gate was not armed.");
    release();
    await batch;
    await awaitImageBatch(storage);

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("stopped_by_user");
    expect(job?.stopRequest?.jobId).toBe(jobId);
    expect(imagePostCount()).toBe(1);
    expect(
      job?.targets.filter((target) => target.status === "succeeded"),
    ).toHaveLength(1);
    expect(
      job?.targets.filter((target) => target.status === "queued").length,
    ).toBe(23);
    expect(isPaidOperationActive()).toBe(false);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  }, 30_000);

  it("keeps prior valid images and never reports a false completion on failures", async () => {
    const storage = await makeStorage();
    for (let index = 0; index < 24; index += 1) {
      const productId = PRODUCT_IDS[index];
      if (!productId) throw new Error("Missing product fixture.");
      await publishValidImage(storage, productId, 300 + index);
    }
    const before = await loadImageManifest(storage);
    const oldActive = before.products.P01?.active;
    const oldFilename = oldActive?.filename ?? "";
    expect(oldActive).toBeDefined();

    const env = await startMock({
      image: (_request, response) => {
        json(response, 200, {
          data: [{ b64_json: "not-an-image", media_type: "image/png" }],
        });
      },
    });
    const jobId = await admitJob(storage, env, ["P01"]);
    const batch = startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await batch;
    await awaitImageBatch(storage);

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(job?.targets[0]?.status).toBe("failed");
    const manifest = await loadImageManifest(storage);
    expect(manifest.products.P01?.active).toEqual(oldActive);
    expect(await storage.readFile(["images", oldFilename])).toBeDefined();
    const setup = await inspectSetupState(storage, { keyAvailable: true });
    expect(setup.status).toBe("completed");
    expect(setup.job.failedRegeneration).toBe(true);
    expect(imagePostCount()).toBe(1);
  });

  it("stops the batch on an authorization failure after one request", async () => {
    const storage = await makeStorage();
    const env = await startMock({
      image: (_request, response) => {
        json(response, 401, { error: { message: "Invalid credentials" } });
      },
    });
    const jobId = await admitJob(storage, env);
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await awaitImageBatch(storage);

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/unauthorized/);
    expect(job?.targets[0]?.status).toBe("failed");
    expect(
      job?.targets.filter((target) => target.status === "queued").length,
    ).toBe(23);
    expect(imagePostCount()).toBe(1);
    expect(isPaidOperationActive()).toBe(false);
  });

  it("sends zero requests when the stop is persisted before the first target", async () => {
    const storage = await makeStorage();
    const env = await startMock();
    const jobId = await admitJob(storage, env);
    await requestStop(storage, jobId);

    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await awaitImageBatch(storage);

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("stopped_by_user");
    expect(imagePostCount()).toBe(0);
    expect(
      job?.targets.every((target) => target.status === "queued"),
    ).toBe(true);
    expect(isPaidOperationActive()).toBe(false);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  });

  it("aborts on insufficient credit and provider mismatch after one request", async () => {
    const storage = await makeStorage();
    const insufficient = await startMock({
      image: (_request, response) => {
        json(response, 402, { error: { message: "Payment required" } });
      },
    });
    const jobId = await admitJob(storage, insufficient);
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env: insufficient,
    });
    await awaitImageBatch(storage);
    let job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/insufficient-credit/);
    expect(imagePostCount()).toBe(1);
    expect(isPaidOperationActive()).toBe(false);

    const storage2 = await makeStorage();
    const requestsBeforeMismatch = imagePostCount();
    const mismatch = await startMock({
      image: (_request, response) => {
        json(response, 200, {
          provider: "unapproved-provider",
          data: [
            {
              b64_json: pngBytes(32, 32).toString("base64"),
              media_type: "image/png",
            },
          ],
          usage: { cost: 0.008 },
        });
      },
    });
    const jobId2 = await admitJob(storage2, mismatch);
    await startImageBatch({
      storage: storage2,
      jobId: jobId2,
      apiKey: "sk-or-v1-batch-key",
      env: mismatch,
    });
    await awaitImageBatch(storage2);
    job = await loadImageJob(storage2);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/provider-mismatch/);
    expect(imagePostCount() - requestsBeforeMismatch).toBe(1);
    expect(isPaidOperationActive()).toBe(false);
  });

  it("releases the lock when the job snapshot is deleted mid-batch", async () => {
    const storage = await makeStorage();
    const env = await startMock({
      image: (_request, response) => {
        json(response, 200, imagePayload(pngBytes(32, 32)));
      },
    });
    const jobId = await admitJob(storage, env);
    await storage.deleteFile(["image-job.json"]);

    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await awaitImageBatch(storage);

    expect(isPaidOperationActive()).toBe(false);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
    expect(await loadImageJob(storage)).toBeUndefined();
  });

  it("records a failed, unbilled-cost attempt when the request is billed but unpublished", async () => {
    const storage = await makeStorage();
    for (let index = 0; index < 23; index += 1) {
      const productId = PRODUCT_IDS[index];
      if (!productId) throw new Error("Missing product fixture.");
      await publishValidImage(storage, productId, 400 + index);
    }
    const env = await startMock({
      image: (_request, response) => {
        response.destroy();
      },
    });
    const jobId = await admitJob(storage, env, ["P24"]);
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await awaitImageBatch(storage);

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(job?.targets[0]?.status).toBe("failed");
    const manifest = await loadImageManifest(storage);
    const attempts = manifest.products.P24?.attempts ?? [];
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.status === "failed")).toBe(true);
    expect(attempts.every((attempt) => attempt.cost.kind === "unknown")).toBe(true);
    expect(manifest.products.P24?.active).toBeNull();
    expect(imagePostCount()).toBe(3);
    expect(isPaidOperationActive()).toBe(false);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  }, 30_000);

  it("marks a partial batch failed without claiming completion", async () => {
    const storage = await makeStorage();
    let count = 0;
    const env = await startMock({
      image: (_request, response) => {
        count += 1;
        if (count === 1) {
          // Non-retryable invalid image data: no automatic retry.
          json(response, 200, {
            data: [
              {
                b64_json: pngBytes(32, 32)
                  .subarray(0, 20)
                  .toString("base64"),
                media_type: "image/png",
              },
            ],
          });
          return;
        }
        json(response, 200, imagePayload(pngBytes(32, 32)));
      },
    });
    const jobId = await admitJob(storage, env);
    await startImageBatch({
      storage,
      jobId,
      apiKey: "sk-or-v1-batch-key",
      env,
    });
    await awaitImageBatch(storage);

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("failed");
    expect(job?.targets.filter((target) => target.status === "succeeded")).toHaveLength(
      23,
    );
    expect(job?.targets.filter((target) => target.status === "failed")).toHaveLength(1);
    const setup = await inspectSetupState(storage, { keyAvailable: true });
    expect(setup.status).toBe("incomplete");
    expect(setup.validImageCount).toBe(23);
  }, 30_000);
});

async function requestStop(storage: Storage, jobId: string): Promise<void> {
  const { requestImageJobStop } = await import("../src/server/image-job");
  const result = await requestImageJobStop({ storage, jobId });
  expect(result.applied).toBe(true);
}
