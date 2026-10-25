import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitImageBatch,
  startImageBatch,
} from "../src/server/image-batch";
import {
  loadImageRecoveryReport,
  recordImageRecoveryFailure,
  recoverInterruptedImageState,
  suggestResumeTargets,
  ImageRecoveryError,
} from "../src/server/image-recovery";
import {
  startImageJob,
  resetAdmittedImageJobsForTests,
  PAID_JOB_LOCK_SEGMENTS,
  PAID_JOB_LOCK_KIND,
} from "../src/server/image-job";
import { AGENT_RUN_LOCK_KIND } from "../src/server/paid-lock";
import {
  appendStartedAttempt,
  createImageJobSnapshot,
  loadImageJob,
  loadImageManifest,
  markAttemptFailed,
  PRODUCT_IDS,
  publishAttempt,
  saveImageJob,
  saveImageManifest,
} from "../src/server/image-state";
import { prepareImageQuote } from "../src/server/image-quote";
import { buildAttemptFilename, validateImageBytes } from "../src/server/image-validation";
import { readBootId, readProcessStartTicks } from "../src/server/process-identity";
import { readLockMetadata } from "../src/server/lock";
import { DEFAULT_IMAGE_MODEL_ID } from "../src/server/model-settings";
import { resetPaidOperationsForTests } from "../src/server/paid-operation";
import { Storage } from "../src/server/storage";
import { attemptId, monotonicStamp, pngBytes } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const servers: Server[] = [];
const requests: Array<{ method: string; path: string }> = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-recovery-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function seedValidImages(storage: Storage, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const productId = PRODUCT_IDS[index];
    if (!productId) throw new Error("Missing product fixture.");
    const id = attemptId(600 + index);
    let manifest = await loadImageManifest(storage);
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
    await saveImageManifest(storage, manifest);
  }
}

async function writeLockMetadata(
  storage: Storage,
  overrides: Record<string, unknown>,
): Promise<void> {
  const bootId = await readBootId();
  const ticks = await readProcessStartTicks(process.pid);
  if (ticks === undefined) throw new Error("Missing process ticks.");
  await storage.writeFile(
    PAID_JOB_LOCK_SEGMENTS,
    `${JSON.stringify(
      {
        version: 1,
        kind: PAID_JOB_LOCK_KIND,
        ownerId: "crashed-job",
        pid: 999_999,
        procStartTicks: 1,
        bootId,
        acquiredAt: new Date().toISOString(),
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

async function saveRunningJob(
  storage: Storage,
  status: "running" = "running",
): Promise<string> {
  const job = createImageJobSnapshot({
    jobId: attemptId(700),
    productIds: [...PRODUCT_IDS],
    now: new Date(),
  });
  await saveImageJob(storage, { ...job, status });
  return job.jobId;
}

async function startMock(): Promise<Record<string, string>> {
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
      json(response, 200, {
        data: [
          {
            b64_json: pngBytes(32, 32).toString("base64"),
            media_type: "image/png",
          },
        ],
        usage: { cost: 0.008 },
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
    DATA_DIR: "/tmp/ai-browser-lab-recovery-test-data",
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
  vi.restoreAllMocks();
});

describe("image restart recovery", () => {
  it("reconciles a crashed batch without any OpenRouter call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const oldP01Active = (await loadImageManifest(storage)).products.P01?.active;
    const jobId = await saveRunningJob(storage);

    // Matching started attempt with a valid unpublished file.
    const orphanId = attemptId(800);
    let manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, "P24", orphanId, {
      startedAt: new Date(Date.now() - 10_000),
    });
    const orphanName = buildAttemptFilename("P24", orphanId, "png");
    await storage.writeFile(["images", orphanName], pngBytes(48, 48));
    // Ambiguous in-flight attempt without any file: charge stays unknown.
    const ambiguousId = attemptId(801);
    manifest = appendStartedAttempt(manifest, "P02", ambiguousId, {
      startedAt: new Date(Date.now() - 10_000),
    });
    await saveImageManifest(storage, manifest);
    // Unmatched orphan file that must be quarantined.
    const unmatchedName = buildAttemptFilename("P05", attemptId(802), "png");
    await storage.writeFile(["images", unmatchedName], pngBytes(16, 16));

    await writeLockMetadata(storage, { ownerId: jobId });

    const result = await recoverInterruptedImageState({ storage });
    expect(result.status).toBe("reconciled");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.reconciliation?.reconciled).toEqual([
      { productId: "P24", attemptId: orphanId, filename: orphanName },
    ]);
    expect(
      result.reconciliation?.quarantined.map((entry) => entry.filename),
    ).toContain(unmatchedName);
    expect(result.jobMarked).toBe("interrupted");

    const recoveryManifest = await loadImageManifest(storage);
    expect(recoveryManifest.products.P24?.active?.attemptId).toBe(orphanId);
    expect(recoveryManifest.products.P01?.active).toEqual(oldP01Active);
    const ambiguous = recoveryManifest.products.P02?.attempts.find(
      (attempt) => attempt.attemptId === ambiguousId,
    );
    expect(ambiguous?.status).toBe("interrupted");
    expect(ambiguous?.cost).toEqual({ kind: "unknown" });

    const job = await loadImageJob(storage);
    expect(job?.status).toBe("interrupted");
    expect(job?.error).toMatch(/restart/i);
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
    expect(
      await storage.readFile(["images", "orphans", unmatchedName]),
    ).toBeDefined();
  });

  it("leaves a live paid owner and an uncertain owner untouched", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const jobId = await saveRunningJob(storage);
    const ticks = await readProcessStartTicks(process.pid);
    const bootId = await readBootId();
    if (ticks === undefined) throw new Error("Missing process ticks.");
    await writeLockMetadata(storage, {
      ownerId: jobId,
      pid: process.pid,
      procStartTicks: ticks,
      bootId,
    });

    const live = await recoverInterruptedImageState({ storage });
    expect(live.status).toBe("active-owner");
    expect((await loadImageJob(storage))?.status).toBe("running");
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeDefined();

    // Uncertain ownership: the lock PID's /proc entry is malformed.
    const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-recovery-proc-"));
    tempDirs.push(base);
    await mkdir(join(base, "sys", "kernel", "random"), { recursive: true });
    await writeFile(join(base, "sys", "kernel", "random", "boot_id"), `${bootId}\n`);
    await mkdir(join(base, String(process.pid)), { recursive: true });
    const fields = Array.from({ length: 49 }, (_, index) =>
      index === 18 ? String(ticks) : "0",
    );
    await writeFile(
      join(base, String(process.pid), "stat"),
      `${process.pid} (node) S ${fields.join(" ")}\n`,
    );
    await mkdir(join(base, "999999"), { recursive: true });
    await writeFile(join(base, "999999", "stat"), "malformed\n");
    await writeLockMetadata(storage, { ownerId: "uncertain-owner" });

    const uncertain = await recoverInterruptedImageState({
      storage,
      procRoot: base,
    });
    expect(uncertain.status).toBe("uncertain");
    expect((await loadImageJob(storage))?.status).toBe("running");
    expect(jobId).toBe((await loadImageJob(storage))?.jobId);
  });

  it("recovers the image state when a live foreign paid owner holds the lock", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const jobId = await saveRunningJob(storage);
    const ticks = await readProcessStartTicks(process.pid);
    const bootId = await readBootId();
    if (ticks === undefined) throw new Error("Missing process ticks.");
    await writeLockMetadata(storage, {
      ownerId: "agent-run-1",
      pid: process.pid,
      procStartTicks: ticks,
      bootId,
    });

    const result = await recoverInterruptedImageState({ storage });
    expect(result.status).toBe("reconciled");
    expect(result.jobMarked).toBe("interrupted");
    expect((await loadImageJob(storage))?.status).toBe("interrupted");
    expect(jobId).toBe((await loadImageJob(storage))?.jobId);
    // The foreign owner's lock is left in place.
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toMatchObject({ ownerId: "agent-run-1" });
  });

  it("marks a crashed job interrupted even when a stop request was persisted", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const jobId = await saveRunningJob(storage);
    const job = await loadImageJob(storage);
    const stoppedStamp = monotonicStamp(job?.updatedAt);
    await saveImageJob(storage, {
      ...(job as NonNullable<typeof job>),
      status: "stopping",
      stopRequest: { jobId, requestedAt: stoppedStamp },
      updatedAt: stoppedStamp,
    });

    const result = await recoverInterruptedImageState({ storage });
    expect(result.status).toBe("reconciled");
    expect(result.jobMarked).toBe("interrupted");
    const stopped = await loadImageJob(storage);
    expect(stopped?.status).toBe("interrupted");
    expect(stopped?.stopRequest?.jobId).toBe(jobId);
    expect((await loadImageRecoveryReport(storage))?.status).toBe("reconciled");
  });

  it("leaves a stale agent-run lock for the agent recovery phase", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    await writeLockMetadata(storage, {
      kind: AGENT_RUN_LOCK_KIND,
      ownerId: attemptId(910),
    });

    const result = await recoverInterruptedImageState({ storage });

    expect(result.lockReleased).toBe(false);
    // The foreign stale lock survives so the agent phase can verify and
    // terminate the orphan worker group before the paid lock is freed.
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toMatchObject({ kind: AGENT_RUN_LOCK_KIND });
  });

  it("clamps a backwards clock step while marking a job interrupted", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    await saveRunningJob(storage);
    const job = (await loadImageJob(storage)) as NonNullable<
      Awaited<ReturnType<typeof loadImageJob>>
    >;
    // Simulate a clock step backwards after this job's timestamps were stored.
    const future = new Date(Date.parse(job.updatedAt) + 5_000);
    await saveImageJob(storage, { ...job, updatedAt: future.toISOString() });

    const result = await recoverInterruptedImageState({
      storage,
      now: new Date(future.getTime() - 4_000),
    });
    expect(result.status).toBe("reconciled");
    expect(result.jobMarked).toBe("interrupted");
    const marked = await loadImageJob(storage);
    expect(marked?.status).toBe("interrupted");
    // The clamp keeps the stored order intact instead of reporting corruption.
    expect(marked?.updatedAt).toBe(future.toISOString());
    expect(
      Date.parse(marked?.updatedAt ?? "") >=
        Date.parse(marked?.createdAt ?? ""),
    ).toBe(true);
  });

  it("quarantines old and invalid attempt-matched files", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const oldP05Active = (await loadImageManifest(storage)).products.P05?.active;

    // Matched attempt whose file is older than the attempt start.
    const oldId = attemptId(820);
    let manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, "P24", oldId, {
      startedAt: new Date(Date.now() + 60_000),
    });
    const oldName = buildAttemptFilename("P24", oldId, "png");
    await storage.writeFile(["images", oldName], pngBytes(16, 16));
    // Matched attempt with a file that fails validation.
    const invalidId = attemptId(821);
    manifest = appendStartedAttempt(manifest, "P05", invalidId, {
      startedAt: new Date(Date.now() - 10_000),
    });
    const invalidName = buildAttemptFilename("P05", invalidId, "png");
    await storage.writeFile(["images", invalidName], Buffer.from("bad image"));
    await saveImageManifest(storage, manifest);

    const result = await recoverInterruptedImageState({ storage });
    expect(result.status).toBe("reconciled");
    const reasons = result.reconciliation?.quarantined.map(
      (entry) => entry.reason,
    );
    expect(reasons).toContain("file modification time precedes the attempt start");
    expect(
      reasons?.some((reason) => reason.startsWith("invalid image")),
    ).toBe(true);

    const after = await loadImageManifest(storage);
    expect(
      after.products.P24?.attempts.find((attempt) => attempt.attemptId === oldId)
        ?.status,
    ).toBe("interrupted");
    expect(
      after.products.P05?.attempts.find(
        (attempt) => attempt.attemptId === invalidId,
      )?.status,
    ).toBe("failed");
    expect(after.products.P05?.active).toEqual(oldP05Active);
  });

  it("excludes reconciliation-rescued images from failed retries", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const orphanId = attemptId(830);
    let manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, "P24", orphanId, {
      startedAt: new Date(Date.now() - 10_000),
    });
    await storage.writeFile(
      ["images", buildAttemptFilename("P24", orphanId, "png")],
      pngBytes(48, 48),
    );
    await saveImageManifest(storage, manifest);
    const job = createImageJobSnapshot({
      jobId: attemptId(831),
      productIds: ["P24"],
      now: new Date(),
    });
    await saveImageJob(storage, {
      ...job,
      status: "failed",
      targets: [
        {
          productId: "P24",
          status: "failed",
          attemptId: attemptId(832),
          error: "boom",
        },
      ],
    });

    await recoverInterruptedImageState({ storage });
    const failed = await suggestResumeTargets(storage, "failed");
    expect(failed.failedTargets).toEqual(["P24"]);
    expect(failed.targets).toEqual([]);
    const missing = await suggestResumeTargets(storage, "missing");
    expect(missing.targets).toEqual([]);
  });

  it("marks an active job interrupted even without a lock file", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    await saveRunningJob(storage);

    const result = await recoverInterruptedImageState({ storage });
    expect(result.status).toBe("reconciled");
    expect(result.jobMarked).toBe("interrupted");
    expect((await loadImageJob(storage))?.status).toBe("interrupted");
  });

  it("suggests missing, failed, and explicit regenerate targets", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);

    const missing = await suggestResumeTargets(storage, "missing");
    expect(missing.targets).toEqual(["P24"]);
    expect(missing.missingTargets).toEqual(["P24"]);
    expect(missing.failedTargets).toEqual([]);

    const failedJob = createImageJobSnapshot({
      jobId: attemptId(701),
      productIds: ["P24"],
      now: new Date(),
    });
    await saveImageJob(storage, {
      ...failedJob,
      status: "failed",
      targets: [
        {
          productId: "P24",
          status: "failed",
          attemptId: attemptId(702),
          error: "boom",
        },
      ],
    });
    const failed = await suggestResumeTargets(storage, "failed");
    expect(failed.targets).toEqual(["P24"]);
    expect(failed.failedTargets).toEqual(["P24"]);

    const regenerate = await suggestResumeTargets(storage, "regenerate", {
      productIds: ["P03", "P01", "P03"],
    });
    expect(regenerate.targets).toEqual(["P01", "P03"]);

    await expect(
      suggestResumeTargets(storage, "regenerate", { productIds: ["P99"] }),
    ).rejects.toThrow(ImageRecoveryError);
  });

  it("surfaces recovery failures in a report file", async () => {
    const storage = await makeStorage();
    await recordImageRecoveryFailure(storage, "corrupt paid-job lock");
    const report = await loadImageRecoveryReport(storage);
    expect(report).toMatchObject({
      status: "failed",
      reason: "corrupt paid-job lock",
    });
  });

  it("resumes after stopped_by_user with a fresh quote and keeps lifetime records", async () => {
    const storage = await makeStorage();
    await seedValidImages(storage, 23);
    const previousFile = buildAttemptFilename("P24", attemptId(710), "png");
    let manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, "P24", attemptId(710), {
      startedAt: new Date(Date.now() - 10_000),
    });
    manifest = markAttemptFailed(manifest, "P24", attemptId(710), {
      finishedAt: new Date(),
      error: "provider error",
      cost: { kind: "reported", usd: 0.004 },
    });
    await saveImageManifest(storage, manifest);
    const job = createImageJobSnapshot({
      jobId: attemptId(711),
      productIds: ["P24"],
      now: new Date(),
    });
    await saveImageJob(storage, {
      ...job,
      status: "stopped_by_user",
      stopRequest: {
        jobId: job.jobId,
        requestedAt: new Date().toISOString(),
      },
      targets: [
        {
          productId: "P24",
          status: "failed",
          attemptId: attemptId(710),
          error: "provider error",
        },
      ],
    });

    const suggestion = await suggestResumeTargets(storage, "failed");
    expect(suggestion.targets).toEqual(["P24"]);

    const env = await startMock();
    const quote = await prepareImageQuote({
      storage,
      apiKey: "sk-or-v1-resume-key",
      selectedIds: suggestion.targets,
      env,
    });
    const admission = await startImageJob({
      storage,
      apiKey: "sk-or-v1-resume-key",
      fingerprint: quote.fingerprint,
      selectedIds: suggestion.targets,
      env,
    });
    expect(admission.status).toBe("started");
    if (admission.status !== "started") return;
    expect(admission.job.targets.map((target) => target.productId)).toEqual([
      "P24",
    ]);

    await startImageBatch({
      storage,
      jobId: admission.job.jobId,
      apiKey: "sk-or-v1-resume-key",
      env,
    });
    await awaitImageBatch(storage);

    expect((await loadImageJob(storage))?.status).toBe("completed");
    expect(
      requests.filter(
        (request) => request.method === "POST" && request.path === "/api/v1/images",
      ),
    ).toHaveLength(1);
    const resumed = await loadImageManifest(storage);
    const attempts = resumed.products.P24?.attempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      status: "failed",
      cost: { kind: "reported", usd: 0.004 },
    });
    expect(attempts[1]?.status).toBe("succeeded");
    expect(resumed.products.P24?.active?.attemptId).toBe(attempts[1]?.attemptId);
    expect(resumed.products.P01?.active).toBeDefined();
    expect(previousFile.length).toBeGreaterThan(0);
  });
});
