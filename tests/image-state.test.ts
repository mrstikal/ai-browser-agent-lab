import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductId } from "../src/lib/products";
import {
  appendStartedAttempt,
  createEmptyImageManifest,
  createImageJobSnapshot,
  deriveSetupState,
  effectiveJobStatus,
  IMAGE_JOB_VERSION,
  IMAGE_MANIFEST_VERSION,
  ImageStateCorruptionError,
  inspectActiveImages,
  inspectSetupState,
  loadImageJob,
  loadImageManifest,
  markAttemptFailed,
  parseImageJobSnapshot,
  PRODUCT_IDS,
  publishAttempt,
  reconcileImages,
  saveImageJob,
  saveImageManifest,
  type ImageJobSnapshot,
  type ImageManifest,
} from "../src/server/image-state";
import { buildAttemptFilename, validateImageBytes } from "../src/server/image-validation";
import { Storage } from "../src/server/storage";
import { attemptId, pngBytes, svgBytes } from "./helpers/image-fixtures";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-image-state-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

async function addPublishedImage(
  storage: Storage,
  manifest: ImageManifest,
  productId: ProductId,
  index: number,
): Promise<{ manifest: ImageManifest; filename: string }> {
  const id = attemptId(index);
  const startedAt = new Date(Date.now() - 10_000);
  let next = appendStartedAttempt(manifest, productId, id, {
    startedAt,
    cost: { kind: "reported", usd: 0.008 },
  });
  const filename = buildAttemptFilename(productId, id, "png");
  const bytes = pngBytes(32, 32);
  await storage.writeFile(["images", filename], bytes);
  const validation = validateImageBytes(bytes, { filename });
  next = publishAttempt(next, productId, id, {
    filename,
    validation,
    publishedAt: new Date(),
    finishedAt: new Date(),
  });
  return { manifest: next, filename };
}

async function publishedManifest(
  storage: Storage,
  count: number,
): Promise<ImageManifest> {
  let manifest = createEmptyImageManifest();
  for (let index = 0; index < count; index += 1) {
    const productId = PRODUCT_IDS[index];
    if (!productId) throw new Error("Missing product fixture.");
    manifest = (await addPublishedImage(storage, manifest, productId, 100 + index))
      .manifest;
  }
  return manifest;
}

async function validImageIds(
  storage: Storage,
  manifest: ImageManifest,
): Promise<ProductId[]> {
  const inspections = await inspectActiveImages(storage, manifest);
  return inspections
    .filter((inspection) => inspection.valid)
    .map((inspection) => inspection.productId);
}

function jobSnapshot(
  status: ImageJobSnapshot["status"],
  targets: readonly ProductId[] = PRODUCT_IDS,
): ImageJobSnapshot {
  const timestamp = "2026-10-23T12:00:00.000Z";
  return {
    version: IMAGE_JOB_VERSION,
    jobId: attemptId(999),
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    targets: targets.map((productId) => ({
      productId,
      status:
        status === "completed"
          ? "succeeded"
          : status === "failed"
            ? "failed"
            : "queued",
      attemptId: null,
      error: null,
    })),
    stopRequest: null,
    error: null,
  };
}

function setup(
  manifest: ImageManifest,
  validIds: readonly ProductId[],
  keyAvailable: boolean,
  job?: ImageJobSnapshot,
  jobIsLive = false,
) {
  return deriveSetupState({
    keyAvailable,
    manifest,
    validImageIds: validIds,
    job,
    jobIsLive,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("image manifest", () => {
  it("creates an empty 24-product ledger and rejects malformed state", async () => {
    const storage = await makeStorage();
    const manifest = createEmptyImageManifest(new Date("2026-10-23T12:00:00Z"));
    expect(Object.keys(manifest.products)).toHaveLength(24);
    expect(manifest.version).toBe(IMAGE_MANIFEST_VERSION);
    expect(manifest.products.P01).toEqual({ active: null, attempts: [] });

    const emptyLoaded = await loadImageManifest(storage);
    expect(emptyLoaded.version).toBe(IMAGE_MANIFEST_VERSION);
    expect(Object.keys(emptyLoaded.products)).toHaveLength(24);
    await storage.writeFile(["images", "manifest.json"], "{bad json");
    const before = await readFile(storage.path(["images", "manifest.json"]), "utf8");
    await expect(loadImageManifest(storage)).rejects.toThrow(
      ImageStateCorruptionError,
    );
    expect(
      await readFile(storage.path(["images", "manifest.json"]), "utf8"),
    ).toBe(before);

    await storage.writeJson(["images", "manifest.json"], {
      ...createEmptyImageManifest(),
      products: { ...createEmptyImageManifest().products, P99: { active: null, attempts: [] } },
    });
    await expect(loadImageManifest(storage)).rejects.toThrow(/unknown product/);
  });

  it("round-trips a saved manifest and rejects a broken active pointer", async () => {
    const storage = await makeStorage();
    const manifest = createEmptyImageManifest();
    const published = await addPublishedImage(storage, manifest, "P01", 1);
    await saveImageManifest(storage, published.manifest);

    const loaded = await loadImageManifest(storage);
    expect(loaded.products.P01.active).toEqual(
      published.manifest.products.P01?.active,
    );
    expect(loaded.products.P01.attempts).toHaveLength(1);

    const broken = structuredClone(loaded) as {
      products: Record<string, { active: { sha256: string } | null }>;
    };
    if (broken.products.P01?.active) {
      broken.products.P01.active.sha256 = "0".repeat(64);
    }
    await expect(
      saveImageManifest(storage, broken as unknown as ImageManifest),
    ).rejects.toThrow(/active image metadata/);
  });
});

describe("setup state", () => {
  it("derives fresh status without trusting a completed flag", async () => {
    const storage = await makeStorage();
    const empty = createEmptyImageManifest();
    expect(setup(empty, [], false).status).toBe("not_configured");
    expect(setup(empty, [], true).status).toBe("ready_to_generate");

    const completedJob = jobSnapshot("completed");
    expect(setup(empty, [], true, completedJob).status).toBe(
      "ready_to_generate",
    );

    const partial = await addPublishedImage(storage, empty, "P01", 1);
    expect(setup(partial.manifest, ["P01"], false).status).toBe("incomplete");
    expect(setup(partial.manifest, ["P01"], true).status).toBe("incomplete");
  });

  it("prefers live generating/stopping over completed images", async () => {
    const storage = await makeStorage();
    const manifest = await publishedManifest(storage, 24);
    const validIds = await validImageIds(storage, manifest);
    expect(setup(manifest, validIds, false).status).toBe("completed");

    expect(setup(manifest, validIds, false, jobSnapshot("running"), true).status).toBe(
      "generating",
    );
    expect(setup(manifest, validIds, false, jobSnapshot("stopping"), true).status).toBe(
      "stopping",
    );
  });

  it("treats a persisted running job as interrupted after restart", async () => {
    const storage = await makeStorage();
    const manifest = await publishedManifest(storage, 1);
    const state = setup(manifest, ["P01"], true, jobSnapshot("running"), false);
    expect(state.status).toBe("incomplete");
    expect(state.job.status).toBe("interrupted");

    const empty = createEmptyImageManifest();
    const emptyState = setup(empty, [], false, jobSnapshot("running"), false);
    expect(emptyState.status).toBe("incomplete");
    expect(emptyState.job.status).toBe("interrupted");
    expect(effectiveJobStatus(jobSnapshot("stopping"), false)).toBe(
      "interrupted",
    );
    expect(effectiveJobStatus(jobSnapshot("queued"), false)).toBe(
      "interrupted",
    );
    expect(effectiveJobStatus(jobSnapshot("completed"), false)).toBe(
      "completed",
    );
  });

  it("shows a failed regeneration separately from completed image setup", async () => {
    const storage = await makeStorage();
    const manifest = await publishedManifest(storage, 24);
    const validIds = await validImageIds(storage, manifest);
    const state = setup(manifest, validIds, true, jobSnapshot("failed"));
    expect(state.status).toBe("completed");
    expect(state.job.status).toBe("failed");
    expect(state.job.failedRegeneration).toBe(true);
    expect(state.validImageCount).toBe(24);
    expect(state.missingImageIds).toEqual([]);

    const stopped = setup(
      manifest,
      validIds,
      true,
      jobSnapshot("stopped_by_user"),
    );
    expect(stopped.status).toBe("completed");
    expect(stopped.job.failedRegeneration).toBe(true);
  });

  it("derives setup state directly from persisted storage", async () => {
    const storage = await makeStorage();
    const manifest = await publishedManifest(storage, 24);
    await saveImageManifest(storage, manifest);
    const state = await inspectSetupState(storage, { keyAvailable: false });
    expect(state.status).toBe("completed");
    expect(state.validImageCount).toBe(24);
  });

  it("reports missing and corrupt active images as incomplete", async () => {
    const storage = await makeStorage();
    const published = await addPublishedImage(
      storage,
      createEmptyImageManifest(),
      "P01",
      1,
    );
    if (!published.filename) throw new Error("Missing filename.");
    await storage.writeFile(["images", published.filename], svgBytes);
    const inspections = await inspectActiveImages(storage, published.manifest);
    expect(inspections).toEqual([
      expect.objectContaining({
        productId: "P01",
        valid: false,
        reason: expect.stringContaining("invalid image"),
      }),
    ]);

    const state = setup(published.manifest, [], true);
    expect(state.status).toBe("incomplete");
    expect(state.invalidActiveImageIds).toEqual(["P01"]);
    expect(state.missingImageIds).toContain("P01");

    await storage.writeFile(["images", published.filename], pngBytes(64, 64));
    expect(
      (await inspectActiveImages(storage, published.manifest))[0]?.reason,
    ).toContain("metadata does not match");

    await rm(storage.path(["images", published.filename]));
    expect(
      (await inspectActiveImages(storage, published.manifest))[0]?.reason,
    ).toContain("missing");
  });

  it("treats a succeeded attempt without an active pointer as incomplete", async () => {
    const storage = await makeStorage();
    const published = await addPublishedImage(
      storage,
      createEmptyImageManifest(),
      "P08",
      60,
    );
    const withoutActive = structuredClone(published.manifest) as {
      products: Record<string, { active: unknown; attempts: unknown[] }>;
    };
    if (withoutActive.products.P08) {
      withoutActive.products.P08.active = null;
    }
    const state = setup(
      withoutActive as unknown as ImageManifest,
      [],
      true,
    );
    expect(state.status).toBe("incomplete");
  });

  it("treats a previous failed attempt as incomplete without images", async () => {
    const storage = await makeStorage();
    let manifest = createEmptyImageManifest();
    const id = attemptId(50);
    manifest = appendStartedAttempt(manifest, "P02", id, {
      startedAt: new Date(Date.now() - 5000),
    });
    manifest = markAttemptFailed(manifest, "P02", id, {
      finishedAt: new Date(),
      error: "provider rejected the request",
      cost: { kind: "reported", usd: 0.004 },
    });
    const state = setup(manifest, [], false);
    expect(state.status).toBe("incomplete");
    expect(state.job.status).toBeNull();
    expect(storage.root.length).toBeGreaterThan(0);
  });
});

describe("image reconciliation", () => {
  it("publishes a matching started attempt without deleting the old active image", async () => {
    const storage = await makeStorage();
    const old = await addPublishedImage(
      storage,
      createEmptyImageManifest(),
      "P01",
      10,
    );
    const newId = attemptId(11);
    const startedAt = new Date(Date.now() - 5000);
    const manifest = appendStartedAttempt(old.manifest, "P01", newId, {
      startedAt,
      cost: { kind: "unknown" },
    });
    const newFilename = buildAttemptFilename("P01", newId, "png");
    const bytes = pngBytes(64, 64);
    await storage.writeFile(["images", newFilename], bytes);
    await saveImageManifest(storage, manifest);

    const result = await reconcileImages(storage, { now: new Date() });
    expect(result.quarantined).toEqual([]);
    expect(result.reconciled).toEqual([
      { productId: "P01", attemptId: newId, filename: newFilename },
    ]);
    expect(result.manifest.products.P01?.active).toMatchObject({
      attemptId: newId,
      filename: newFilename,
      width: 64,
      height: 64,
    });
    expect(result.manifest.products.P01?.attempts).toHaveLength(2);
    expect(result.manifest.products.P01?.attempts[1]).toMatchObject({
      status: "succeeded",
      attemptId: newId,
      cost: { kind: "unknown" },
    });
    expect(await storage.readFile(["images", old.filename])).toBeDefined();
    expect(await storage.readFile(["images", newFilename])).toBeDefined();
  });

  it("quarantines unmatched files and does not publish them", async () => {
    const storage = await makeStorage();
    const orphanId = attemptId(20);
    const orphan = buildAttemptFilename("P02", orphanId, "png");
    await storage.writeFile(["images", orphan], pngBytes(20, 20));

    const result = await reconcileImages(storage);
    expect(result.reconciled).toEqual([]);
    expect(result.quarantined).toEqual([
      expect.objectContaining({
        filename: orphan,
        reason: "no matching started attempt",
        movedTo: orphan,
      }),
    ]);
    expect(result.manifest.products.P02?.active).toBeNull();
    expect(await storage.readFile(["images", orphan])).toBeUndefined();
    expect(
      await storage.readFile(["images", "orphans", orphan]),
    ).toBeDefined();
  });

  it("quarantines a matching attempt when the file is invalid or too old", async () => {
    const storage = await makeStorage();
    let manifest = createEmptyImageManifest();
    const invalidId = attemptId(21);
    manifest = appendStartedAttempt(manifest, "P03", invalidId, {
      startedAt: new Date(Date.now() - 5000),
    });
    const invalidFile = buildAttemptFilename("P03", invalidId, "png");
    await storage.writeFile(["images", invalidFile], Buffer.from("bad image"));

    const oldId = attemptId(22);
    manifest = appendStartedAttempt(manifest, "P04", oldId, {
      startedAt: new Date(Date.now() - 30_000),
    });
    const oldFile = buildAttemptFilename("P04", oldId, "png");
    await storage.writeFile(["images", oldFile], pngBytes(16, 16));
    await utimes(
      storage.path(["images", oldFile]),
      new Date(Date.now() - 120_000),
      new Date(Date.now() - 120_000),
    );
    await saveImageManifest(storage, manifest);

    const result = await reconcileImages(storage, { now: new Date() });
    expect(result.reconciled).toEqual([]);
    expect(result.quarantined.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("invalid image"),
        "file modification time precedes the attempt start",
      ]),
    );
    expect(result.manifest.products.P03?.attempts[0]?.status).toBe("failed");
    expect(result.manifest.products.P04?.attempts[0]?.status).toBe("interrupted");
    expect(await storage.readFile(["images", "orphans", invalidFile])).toBeDefined();
    expect(await storage.readFile(["images", "orphans", oldFile])).toBeDefined();
  });

  it("marks a future-dated started attempt interrupted without aborting recovery", async () => {
    const storage = await makeStorage();
    const id = attemptId(24);
    const startedAt = new Date(Date.now() + 60_000);
    const manifest = appendStartedAttempt(
      createEmptyImageManifest(),
      "P09",
      id,
      { startedAt },
    );
    await saveImageManifest(storage, manifest);

    const result = await reconcileImages(storage, { now: new Date() });
    expect(result.interruptedAttempts).toEqual([
      { productId: "P09", attemptId: id },
    ]);
    expect(result.manifest.products.P09?.attempts[0]?.finishedAt).toBe(
      startedAt.toISOString(),
    );
  });

  it("marks started attempts interrupted when no file matches", async () => {
    const storage = await makeStorage();
    const id = attemptId(23);
    const manifest = appendStartedAttempt(
      createEmptyImageManifest(),
      "P05",
      id,
      { startedAt: new Date(Date.now() - 5000) },
    );
    await saveImageManifest(storage, manifest);

    const result = await reconcileImages(storage);
    expect(result.interruptedAttempts).toEqual([
      { productId: "P05", attemptId: id },
    ]);
    expect(result.manifest.products.P05?.attempts[0]).toMatchObject({
      status: "interrupted",
      cost: { kind: "unknown" },
    });
  });

  it("keeps a referenced old image and reports a corrupt active file", async () => {
    const storage = await makeStorage();
    const published = await addPublishedImage(
      storage,
      createEmptyImageManifest(),
      "P06",
      30,
    );
    await storage.writeFile(["images", published.filename], Buffer.from("corrupt"));
    await saveImageManifest(storage, published.manifest);

    const result = await reconcileImages(storage);
    expect(result.quarantined).toEqual([]);
    expect(await storage.readFile(["images", published.filename])).toBeDefined();
    expect(result.manifest.products.P06?.active?.filename).toBe(
      published.filename,
    );
    expect(result.activeImages[0]).toMatchObject({
      productId: "P06",
      valid: false,
    });
    expect(setup(result.manifest, [], true).status).toBe("incomplete");
  });

  it("refuses reconciliation while a persisted active job exists", async () => {
    const storage = await makeStorage();
    await saveImageJob(storage, jobSnapshot("running", ["P01"]));
    await expect(reconcileImages(storage)).rejects.toThrow(/active job/);
    const result = await reconcileImages(storage, { allowActiveJob: true });
    expect(result.manifest.version).toBe(IMAGE_MANIFEST_VERSION);
  });

  it("recovers when the manifest save fails after quarantining", async () => {
    const storage = await makeStorage();
    const id = attemptId(70);
    const manifest = appendStartedAttempt(
      createEmptyImageManifest(),
      "P03",
      id,
      { startedAt: new Date(Date.now() - 5000) },
    );
    await saveImageManifest(storage, manifest);
    const badFile = buildAttemptFilename("P03", id, "png");
    await storage.writeFile(["images", badFile], Buffer.from("bad image"));

    const spy = vi
      .spyOn(storage, "writeJson")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(reconcileImages(storage)).rejects.toThrow("disk full");
    spy.mockRestore();

    expect(await storage.readFile(["images", badFile])).toBeUndefined();
    expect(
      await storage.readFile(["images", "orphans", badFile]),
    ).toBeDefined();
    expect(
      (await loadImageManifest(storage)).products.P03?.attempts[0]?.status,
    ).toBe("started");

    const retry = await reconcileImages(storage);
    expect(retry.manifest.products.P03?.attempts[0]?.status).toBe(
      "interrupted",
    );
  });

  it("ignores directories and quarantines symlink entries", async () => {
    const storage = await makeStorage();
    await mkdir(storage.path(["images", "subdir"]), { recursive: true });
    await storage.writeFile(["target.png"], pngBytes(8, 8));
    const linkName = buildAttemptFilename("P10", attemptId(71), "png");
    await symlink(
      storage.path(["target.png"]),
      storage.path(["images", linkName]),
    );

    const result = await reconcileImages(storage);
    expect(result.quarantined).toEqual([
      expect.objectContaining({
        filename: linkName,
        reason: "no matching started attempt",
      }),
    ]);
    expect(
      (await lstat(storage.path(["images", "subdir"]))).isDirectory(),
    ).toBe(true);
    expect(
      (await lstat(storage.path(["images", "orphans", linkName]))).isSymbolicLink(),
    ).toBe(true);
  });

  it("avoids overwriting an existing quarantine file", async () => {
    const storage = await makeStorage();
    const id = attemptId(31);
    const name = buildAttemptFilename("P07", id, "png");
    await storage.writeFile(["images", name], pngBytes(10, 10));
    await storage.writeFile(["images", "orphans", name], Buffer.from("old"));

    const result = await reconcileImages(storage);
    const movedTo = result.quarantined[0]?.movedTo;
    expect(movedTo).not.toBe(name);
    expect(movedTo).toMatch(new RegExp(`^P07-${id}-[0-9a-f-]+\\.png$`));
    expect(await storage.readFile(["images", "orphans", name])).toEqual(
      Buffer.from("old"),
    );
    expect(
      await storage.readFile(["images", "orphans", movedTo ?? "missing"]),
    ).toBeDefined();
  });
});

describe("image job snapshot", () => {
  it("round-trips a queued job and rejects a mismatched stop request", async () => {
    const storage = await makeStorage();
    const job = createImageJobSnapshot({
      jobId: attemptId(40),
      productIds: ["P01", "P02"],
      now: new Date("2026-10-23T12:00:00Z"),
    });
    await saveImageJob(storage, job);
    expect(await loadImageJob(storage)).toEqual(job);
    expect(job.status).toBe("queued");
    expect(job.targets).toEqual([
      { productId: "P01", status: "queued", attemptId: null, error: null },
      { productId: "P02", status: "queued", attemptId: null, error: null },
    ]);

    await expect(
      saveImageJob(storage, {
        ...job,
        stopRequest: { jobId: attemptId(41), requestedAt: job.createdAt },
      }),
    ).rejects.toThrow(/stopRequest.jobId/);
  });

  it("rejects nonsense job snapshots at the persistence boundary", async () => {
    const base = createImageJobSnapshot({
      jobId: attemptId(42),
      productIds: ["P01"],
      now: new Date("2026-10-23T12:00:00Z"),
    });
    expect(() =>
      parseImageJobSnapshot({ ...base, targets: [] }),
    ).toThrow(/non-empty/);
    expect(() =>
      parseImageJobSnapshot({
        ...base,
        status: "completed",
        targets: [
          { productId: "P01", status: "queued", attemptId: null, error: null },
        ],
      }),
    ).toThrow(/completed jobs/);
    expect(() =>
      parseImageJobSnapshot({ ...base, status: "stopping" }),
    ).toThrow(/stop request/);
  });

  it("rejects malformed job JSON without rewriting it", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["image-job.json"], "{bad");
    const before = await readFile(storage.path(["image-job.json"]), "utf8");
    await expect(loadImageJob(storage)).rejects.toThrow(
      ImageStateCorruptionError,
    );
    expect(await readFile(storage.path(["image-job.json"]), "utf8")).toBe(before);
  });
});
