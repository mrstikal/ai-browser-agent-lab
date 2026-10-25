import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createImageJobSnapshot,
  appendStartedAttempt,
  loadImageManifest,
  markAttemptFailed,
  PRODUCT_IDS,
  publishAttempt,
  saveImageManifest,
  saveImageJob,
} from "../src/server/image-state";
import { loadImageProgress } from "../src/server/image-progress";
import {
  markImageJobLiveForTests,
  resetImageJobLivenessForTests,
} from "../src/server/image-job-liveness";
import { buildAttemptFilename, validateImageBytes } from "../src/server/image-validation";
import { resetCredentialHolderForTests } from "../src/server/credentials";
import { Storage } from "../src/server/storage";
import { attemptId, pngBytes } from "./helpers/image-fixtures";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-progress-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

async function publishValidImages(storage: Storage, count: number): Promise<void> {
  let manifest = await loadImageManifest(storage);
  for (let index = 0; index < count; index += 1) {
    const productId = PRODUCT_IDS[index];
    if (!productId) throw new Error("Missing product fixture.");
    const id = attemptId(900 + index);
    manifest = appendStartedAttempt(manifest, productId, id, {
      startedAt: new Date(Date.now() - 5000),
    });
    const filename = buildAttemptFilename(productId, id, "png");
    const bytes = pngBytes(32, 32);
    await storage.writeFile(["images", filename], bytes);
    manifest = publishAttempt(manifest, productId, id, {
      filename,
      validation: await validateImageBytes(bytes, { filename }),
      publishedAt: new Date(),
      finishedAt: new Date(),
    });
  }
  await saveImageManifest(storage, manifest);
}

async function saveJob(
  storage: Storage,
  status: "queued" | "running" | "stopping" | "completed" | "failed" | "interrupted" | "stopped_by_user",
  targets?: Array<{
    productId: "P04" | "P05" | "P24";
    status: "queued" | "generating" | "succeeded" | "failed" | "reused";
    attemptId?: string | null;
    error?: string | null;
  }>,
): Promise<string> {
  const job = createImageJobSnapshot({
    jobId: attemptId(950),
    productIds: (targets ?? [{ productId: "P04", status: "queued" }]).map(
      (target) => target.productId,
    ),
    now: new Date(),
  });
  const snapshot = {
    ...job,
    status,
    ...(status === "stopping" || status === "stopped_by_user"
      ? { stopRequest: { jobId: job.jobId, requestedAt: new Date().toISOString() } }
      : {}),
    targets: (targets ?? [{ productId: "P04", status: "queued" }]).map((target) => ({
      productId: target.productId,
      status: target.status,
      attemptId: target.attemptId ?? null,
      error: target.error ?? null,
    })),
  };
  await saveImageJob(storage, snapshot);
  return job.jobId;
}

afterEach(async () => {
  resetCredentialHolderForTests();
  resetImageJobLivenessForTests();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("image progress snapshot", () => {
  it("reports the fresh-install zero state without any job", async () => {
    const storage = await makeStorage();
    const snapshot = await loadImageProgress(storage, {
      env: { DATA_DIR: storage.root },
    });
    expect(snapshot.error).toBeNull();
    expect(snapshot.setup.status).toBe("not_configured");
    expect(snapshot.setup.validImageCount).toBe(0);
    expect(snapshot.job.status).toBeNull();
    expect(snapshot.preview).toHaveLength(24);
    expect(snapshot.preview.every((item) => !item.valid && item.imageUrl === null)).toBe(
      true,
    );
    expect(snapshot.resume.missingTargets).toHaveLength(24);
    expect(snapshot.costs.totalAttempts).toBe(0);
  });

  it("reports partial images and a running job with counters and preview URLs", async () => {
    const storage = await makeStorage();
    await publishValidImages(storage, 3);
    await saveJob(storage, "running", [
      { productId: "P04", status: "queued" },
      { productId: "P05", status: "generating" },
    ]);

    const snapshot = await loadImageProgress(storage, {
      env: { DATA_DIR: storage.root },
    });
    expect(snapshot.setup.status).toBe("incomplete");
    expect(snapshot.setup.validImageCount).toBe(3);
    expect(snapshot.job.status).toBe("running");
    expect(snapshot.job.counts).toEqual({
      queued: 1,
      generating: 1,
      succeeded: 0,
      failed: 0,
      reused: 0,
    });
    expect(snapshot.preview.filter((item) => item.valid)).toHaveLength(3);
    expect(snapshot.preview[0]?.imageUrl).toMatch(/^\/api\/images\/P01\?v=/);
    expect(snapshot.resume.missingTargets).toHaveLength(21);
  });

  it("labels reported, estimated, and unknown attempt costs with failures", async () => {
    const storage = await makeStorage();
    await publishValidImages(storage, 3);
    const reportedId = attemptId(920);
    const estimatedId = attemptId(921);
    const unknownId = attemptId(922);
    let manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, "P04", reportedId, {
      startedAt: new Date(Date.now() - 5000),
    });
    manifest = markAttemptFailed(manifest, "P04", reportedId, {
      finishedAt: new Date(),
      error: "provider error",
      cost: { kind: "reported", usd: 0.004 },
    });
    manifest = appendStartedAttempt(manifest, "P04", estimatedId, {
      startedAt: new Date(Date.now() - 4000),
    });
    manifest = markAttemptFailed(manifest, "P04", estimatedId, {
      finishedAt: new Date(),
      error: "timeout",
      cost: { kind: "estimated", usd: 0.008 },
    });
    manifest = appendStartedAttempt(manifest, "P05", unknownId, {
      startedAt: new Date(Date.now() - 3000),
    });
    await saveImageManifest(storage, manifest);
    await saveJob(storage, "failed", [
      {
        productId: "P04",
        status: "failed",
        attemptId: reportedId,
        error: "provider error",
      },
    ]);

    const snapshot = await loadImageProgress(storage, {
      env: { DATA_DIR: storage.root },
    });
    expect(snapshot.job.status).toBe("failed");
    expect(snapshot.job.counts.failed).toBe(1);
    expect(snapshot.job.targets[0]).toMatchObject({
      productId: "P04",
      status: "failed",
      error: "provider error",
      cost: { kind: "reported", usd: 0.004 },
    });
    expect(snapshot.costs).toMatchObject({
      reportedUsd: "0.004",
      estimatedUsd: "0.008",
      unknownAttempts: 4,
      totalAttempts: 6,
    });
    expect(snapshot.resume.retryableTargets).toContain("P04");
    const missing = snapshot.resume.missingTargets;
    expect(missing).toContain("P04");
  });

  it("reports stopping and stopped_by_user states with the persisted stop request", async () => {
    const storage = await makeStorage();
    await publishValidImages(storage, 23);
    const jobId = await saveJob(storage, "stopping", [
      { productId: "P24", status: "queued" },
    ]);
    markImageJobLiveForTests(storage, jobId);
    const stopping = await loadImageProgress(storage, {
      env: { DATA_DIR: storage.root },
    });
    expect(stopping.job).toMatchObject({
      status: "stopping",
      stopRequested: true,
    });
    expect(stopping.setup.status).toBe("stopping");

    await saveJob(storage, "stopped_by_user", [
      {
        productId: "P24",
        status: "failed",
        error: "provider error",
      },
    ]);
    const stopped = await loadImageProgress(storage, {
      env: { DATA_DIR: storage.root },
    });
    expect(stopped.job.status).toBe("stopped_by_user");
    expect(stopped.job.stopRequested).toBe(true);
    expect(stopped.resume.retryableTargets).toEqual(["P24"]);
    expect(stopped.resume.missingTargets).toEqual(["P24"]);
  });

  it("reports a completed 24-of-24 setup and no resume targets", async () => {
    const storage = await makeStorage();
    await publishValidImages(storage, 24);
    await saveJob(storage, "completed", [
      { productId: "P24", status: "succeeded", attemptId: attemptId(999) },
    ]);
    const snapshot = await loadImageProgress(storage, {
      env: { DATA_DIR: storage.root },
    });
    expect(snapshot.setup.status).toBe("completed");
    expect(snapshot.setup.validImageCount).toBe(24);
    expect(snapshot.resume.missingTargets).toEqual([]);
    expect(snapshot.preview.every((item) => item.valid)).toBe(true);
  });

  it("reports unreadable manifest and job state without throwing", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["images", "manifest.json"], "{bad");
    const manifestError = await loadImageProgress(storage, {
      env: { DATA_DIR: storage.root },
    });
    expect(manifestError.error).toMatch(/Image state is unreadable/);

    const storage2 = await makeStorage();
    await storage2.writeFile(["image-job.json"], "{bad");
    const jobError = await loadImageProgress(storage2, {
      env: { DATA_DIR: storage2.root },
    });
    expect(jobError.error).toMatch(/job state is unreadable/);
  });
});