import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admittedImageJobId,
  PAID_JOB_LOCK_SEGMENTS,
  releaseAdmittedImageJob,
  requestImageJobStop,
  resetAdmittedImageJobsForTests,
  startImageJob,
  updateImageJob,
} from "../src/server/image-job";
import {
  createImageJobSnapshot,
  loadImageJob,
  saveImageJob,
} from "../src/server/image-state";
import { DEFAULT_IMAGE_MODEL_ID } from "../src/server/model-settings";
import { prepareImageQuote } from "../src/server/image-quote";
import { acquireLock, readLockMetadata } from "../src/server/lock";
import {
  isPaidOperationActive,
  resetPaidOperationsForTests,
} from "../src/server/paid-operation";
import { Storage } from "../src/server/storage";
import { attemptId, monotonicStamp } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const servers: Server[] = [];
let price = 0.008;
const requests: Array<{ method: string; path: string }> = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-job-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startCatalog(): Promise<Record<string, string>> {
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
              { billable: "output_image", unit: "image", cost_usd: price, variant: "768" },
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
  return {
    LAB_TEST_MODE: "1",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
    DATA_DIR: "/tmp/ai-browser-lab-job-test-data",
  };
}

async function fingerprintFor(
  storage: Storage,
  env: Record<string, string>,
): Promise<string> {
  const quote = await prepareImageQuote({
    storage,
    apiKey: "sk-or-v1-job-key",
    env,
  });
  return quote.fingerprint;
}

afterEach(async () => {
  await resetAdmittedImageJobsForTests();
  resetPaidOperationsForTests();
  requests.length = 0;
  price = 0.008;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("image job admission", () => {
  it("keeps updatedAt monotonic when the wall clock steps backwards", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);
    const admitted = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(admitted.status).toBe("started");
    if (admitted.status !== "started") return;

    // Simulate a WSL/NTP clock step: an update stamped before the job existed.
    const steppedBack = new Date(Date.parse(admitted.job.createdAt) - 60_000);
    const updated = await updateImageJob(
      storage,
      admitted.job.jobId,
      (current) => ({ ...current, status: "running" }),
      steppedBack,
    );
    expect(updated).not.toBeNull();
    expect(updated?.updatedAt).toBe(admitted.job.updatedAt);
    expect(Date.parse(updated?.updatedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(admitted.job.createdAt),
    );
    expect((await loadImageJob(storage))?.status).toBe("running");
  });

  it("acquires the paid lock with the job UUID, rechecks the quote, and persists a queued job", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);

    const requestsBefore = requests.length;
    const result = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(result.status).toBe("started");
    if (result.status !== "started") return;

    expect(result.job.status).toBe("queued");
    expect(result.job.targets).toHaveLength(24);
    expect(result.job.quote?.fingerprint).toBe(fingerprint);
    expect(result.job.quote?.providerOnly).toEqual(["cheap"]);
    expect(admittedImageJobId(storage)).toBe(result.job.jobId);
    expect(isPaidOperationActive()).toBe(true);

    const lock = await readLockMetadata(
      storage.path(PAID_JOB_LOCK_SEGMENTS),
    );
    expect(lock).toMatchObject({
      kind: "paid-job",
      ownerId: result.job.jobId,
      pid: process.pid,
    });

    expect(await loadImageJob(storage)).toEqual(result.job);
    const newRequests = requests.slice(requestsBefore);
    expect(newRequests.every((request) => request.method === "GET")).toBe(true);
    expect(
      newRequests.some((request) => request.method === "POST"),
    ).toBe(false);
  });

  it("returns the same job for duplicate start requests without a second batch", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);

    const first = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(first.status).toBe("started");
    if (first.status !== "started") return;

    const requestsAfterFirst = requests.length;
    const second = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(second.status).toBe("existing");
    if (second.status === "existing") {
      expect(second.job.jobId).toBe(first.job.jobId);
    }
    expect(requests.length).toBe(requestsAfterFirst);

    const competitor = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint: "a".repeat(64),
      env,
    });
    expect(competitor.status).toBe("job-active");

    const lock = await readLockMetadata(
      storage.path(PAID_JOB_LOCK_SEGMENTS),
    );
    expect(lock?.ownerId).toBe(first.job.jobId);
  });

  it("releases the lock on a changed quote without persisting a job or posting images", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);

    price = 0.009;
    const result = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(result.status).toBe("quote-changed");
    if (result.status === "quote-changed") {
      expect(result.quote.unitPriceUsd).toBe("0.009");
      expect(result.quote.fingerprint).not.toBe(fingerprint);
    }
    expect(await loadImageJob(storage)).toBeUndefined();
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
    expect(isPaidOperationActive()).toBe(false);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("serializes concurrent duplicate starts into one admitted job", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);
    const requestsBefore = requests.length;

    const [left, right] = await Promise.all([
      startImageJob({ storage, apiKey: "sk-or-v1-job-key", fingerprint, env }),
      startImageJob({ storage, apiKey: "sk-or-v1-job-key", fingerprint, env }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual(["existing", "started"]);
    const started = left.status === "started" ? left : right;
    const existing = left.status === "existing" ? left : right;
    if (started.status === "started" && existing.status === "existing") {
      expect(existing.job.jobId).toBe(started.job.jobId);
    }
    expect(admittedImageJobId(storage)).not.toBeNull();
    expect(requests.length).toBe(requestsBefore + 2);
    expect((await loadImageJob(storage))?.status).toBe("queued");
  });

  it("reports no-job for a stop when nothing is persisted", async () => {
    const storage = await makeStorage();
    const result = await requestImageJobStop({
      storage,
      jobId: attemptId(904),
    });
    expect(result).toMatchObject({ applied: false, reason: "no-job" });
  });

  it("keeps the admission fail-closed when the lock cannot be released", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);
    const started = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(started.status).toBe("started");
    if (started.status !== "started") return;

    const metadata = await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS));
    if (!metadata) throw new Error("Missing lock metadata.");
    await storage.writeFile(
      PAID_JOB_LOCK_SEGMENTS,
      `${JSON.stringify({ ...metadata, ownerId: "replacement-owner" }, null, 2)}\n`,
    );

    expect(
      await releaseAdmittedImageJob({ storage, jobId: started.job.jobId }),
    ).toBe(false);
    expect(admittedImageJobId(storage)).toBe(started.job.jobId);
    expect(isPaidOperationActive()).toBe(true);
  });

  it("keeps the admitted lock and job across module reloads", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);
    const started = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(started.status).toBe("started");
    if (started.status !== "started") return;

    vi.resetModules();
    const reloaded = await import("../src/server/image-job");
    expect(reloaded.admittedImageJobId(storage)).toBe(started.job.jobId);
    expect(
      await reloaded.releaseAdmittedImageJob({
        storage,
        jobId: started.job.jobId,
      }),
    ).toBe(true);
    expect(isPaidOperationActive()).toBe(false);
  });

  it("rejects a persisted active job or a lock held elsewhere without admitting", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const persisted = createImageJobSnapshot({
      jobId: attemptId(900),
      productIds: ["P01"],
      now: new Date(),
    });
    await saveImageJob(storage, {
      ...persisted,
      status: "running",
    });

    const result = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint: "b".repeat(64),
      env,
    });
    expect(result.status).toBe("job-active");
    if (result.status === "job-active") {
      expect(result.job?.jobId).toBe(persisted.jobId);
    }
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();

    await saveImageJob(storage, {
      ...persisted,
      status: "failed",
    });
    const foreignLock = await acquireLock(storage, PAID_JOB_LOCK_SEGMENTS, {
      kind: "paid-job",
      ownerId: "other-process-job",
    });
    const blocked = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint: "b".repeat(64),
      env,
    });
    expect(blocked.status).toBe("paid-operation-active");
    await foreignLock.release();
  });

  it("rejects unverifiable quotes after acquiring and releasing the lock", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const persisted = createImageJobSnapshot({
      jobId: attemptId(901),
      productIds: ["P01"],
      now: new Date(),
    });
    await saveImageJob(storage, { ...persisted, status: "failed" });

    const result = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint: "c".repeat(64),
      selection: {
        modelId: "missing/model",
        resolution: "768",
        aspectRatio: "1:1",
        format: "png",
        n: 1,
      },
      env,
    });
    expect(result.status).toBe("quote-rejected");
    if (result.status === "quote-rejected") {
      expect(result.code).toBe("stale-model");
    }
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
    expect(isPaidOperationActive()).toBe(false);
  });

  it("applies stop only to the current active job and never to a later batch", async () => {
    const storage = await makeStorage();
    const env = await startCatalog();
    const fingerprint = await fingerprintFor(storage, env);
    const started = await startImageJob({
      storage,
      apiKey: "sk-or-v1-job-key",
      fingerprint,
      env,
    });
    expect(started.status).toBe("started");
    if (started.status !== "started") return;

    const wrong = await requestImageJobStop({
      storage,
      jobId: attemptId(902),
    });
    expect(wrong).toMatchObject({ applied: false, reason: "wrong-job" });
    expect((await loadImageJob(storage))?.stopRequest).toBeNull();

    const applied = await requestImageJobStop({
      storage,
      jobId: started.job.jobId,
    });
    expect(applied.applied).toBe(true);
    if (applied.applied) {
      expect(applied.job.status).toBe("stopping");
      expect(applied.job.stopRequest?.jobId).toBe(started.job.jobId);
    }
    const stored = await loadImageJob(storage);
    expect(stored?.status).toBe("stopping");
    expect(stored?.stopRequest?.jobId).toBe(started.job.jobId);

    const duplicate = await requestImageJobStop({
      storage,
      jobId: started.job.jobId,
    });
    expect(duplicate).toMatchObject({ applied: false, reason: "duplicate" });

    expect(
      await releaseAdmittedImageJob({ storage, jobId: started.job.jobId }),
    ).toBe(true);
    expect(isPaidOperationActive()).toBe(false);

    await saveImageJob(storage, {
      ...(stored as NonNullable<typeof stored>),
      status: "stopped_by_user",
      updatedAt: monotonicStamp(stored?.updatedAt),
    });
    const finished = await requestImageJobStop({
      storage,
      jobId: started.job.jobId,
    });
    expect(finished).toMatchObject({ applied: false, reason: "finished" });

    const later = createImageJobSnapshot({
      jobId: attemptId(903),
      productIds: ["P01"],
      now: new Date(),
    });
    await saveImageJob(storage, { ...later, status: "running" });
    const lateStop = await requestImageJobStop({
      storage,
      jobId: started.job.jobId,
    });
    expect(lateStop).toMatchObject({ applied: false, reason: "wrong-job" });
    expect((await loadImageJob(storage))?.jobId).toBe(later.jobId);
    expect((await loadImageJob(storage))?.status).toBe("running");
    expect((await loadImageJob(storage))?.stopRequest).toBeNull();
  });
});
