import { randomUUID } from "node:crypto";
import type { ProductId } from "../lib/products";
import { products } from "../lib/products";
import { PAID_JOB_LOCK_KIND, PAID_JOB_LOCK_SEGMENTS } from "./image-job";
import {
  inspectActiveImages,
  isActiveImageJobStatus,
  loadImageJob,
  loadImageManifest,
  reconcileImages,
  saveImageJob,
  type ImageJobSnapshot,
  type ImageJobStatus,
  type ReconcileResult,
  clampJobUpdatedAt,
} from "./image-state";
import { isProductId } from "./image-validation";
import {
  acquireLock,
  classifyLockOwner,
  LockError,
  LockHeldError,
  readLockMetadata,
  type LockMetadata,
  type OwnerLock,
} from "./lock";
import type { ProcOptions } from "./process-identity";
import { Storage } from "./storage";

export const IMAGE_RECOVERY_REPORT_SEGMENTS = ["image-recovery.json"] as const;

export type ImageRecoveryStatus = "reconciled" | "active-owner" | "uncertain";

export interface ImageRecoveryResult {
  readonly status: ImageRecoveryStatus;
  readonly reconciliation: ReconcileResult | null;
  readonly jobId: string | null;
  readonly jobMarked: ImageJobStatus | null;
  readonly lockReleased: boolean;
  readonly reason: string | null;
}

export interface ImageRecoveryReport {
  readonly version: 1;
  readonly at: string;
  readonly status: ImageRecoveryStatus | "failed";
  readonly reason: string | null;
  readonly jobId: string | null;
  readonly jobMarked: ImageJobStatus | null;
  readonly reconciledCount: number;
  readonly quarantinedCount: number;
}

export class ImageRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRecoveryError";
  }
}

export interface RecoverInterruptedImageStateOptions extends ProcOptions {
  readonly storage: Storage;
  readonly now?: Date | undefined;
}

async function writeReport(
  storage: Storage,
  report: ImageRecoveryReport,
): Promise<void> {
  try {
    await storage.writeJson(IMAGE_RECOVERY_REPORT_SEGMENTS, report);
  } catch {
    // A failed report write must never mask the recovery outcome.
  }
}

function reportFrom(
  result: ImageRecoveryResult,
  at: string,
): ImageRecoveryReport {
  return {
    version: 1,
    at,
    status: result.status,
    reason: result.reason,
    jobId: result.jobId,
    jobMarked: result.jobMarked,
    reconciledCount: result.reconciliation?.reconciled.length ?? 0,
    quarantinedCount: result.reconciliation?.quarantined.length ?? 0,
  };
}

/**
 * Records a recovery failure so the state UI can surface corrupt saved state
 * instead of leaving it console-only.
 */
export async function recordImageRecoveryFailure(
  storage: Storage,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await writeReport(storage, {
    version: 1,
    at: now.toISOString(),
    status: "failed",
    reason,
    jobId: null,
    jobMarked: null,
    reconciledCount: 0,
    quarantinedCount: 0,
  });
}

export async function loadImageRecoveryReport(
  storage: Storage,
): Promise<ImageRecoveryReport | undefined> {
  const raw = await storage.readJson<unknown>(IMAGE_RECOVERY_REPORT_SEGMENTS);
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.at !== "string" ||
    typeof record.status !== "string" ||
    !["reconciled", "active-owner", "uncertain", "failed"].includes(
      record.status,
    )
  ) {
    return undefined;
  }
  return {
    version: 1,
    at: record.at,
    status: record.status as ImageRecoveryReport["status"],
    reason: typeof record.reason === "string" ? record.reason : null,
    jobId: typeof record.jobId === "string" ? record.jobId : null,
    jobMarked:
      typeof record.jobMarked === "string"
        ? (record.jobMarked as ImageJobStatus)
        : null,
    reconciledCount:
      typeof record.reconciledCount === "number" ? record.reconciledCount : 0,
    quarantinedCount:
      typeof record.quarantinedCount === "number" ? record.quarantinedCount : 0,
  };
}

async function markInterruptedJob(
  storage: Storage,
  job: ImageJobSnapshot,
  now: Date,
): Promise<ImageJobStatus> {
  // Process death is always "interrupted", even when a stop was requested: the
  // stop was never settled by the worker, so stopped_by_user would claim an
  // outcome that did not happen. The stop request itself is preserved.
  const marked = {
    ...job,
    status: "interrupted" as const,
    error:
      "Interrupted by a server restart. Confirm a fresh quote to retry or resume; no request is sent automatically.",
    targets: job.targets.map((target) =>
      target.status === "generating"
        ? {
            ...target,
            status: "failed" as const,
            error: "Interrupted by a server restart; no automatic retry.",
          }
        : target,
    ),
    updatedAt: clampJobUpdatedAt(job, now),
  };
  await saveImageJob(storage, marked);
  return "interrupted";
}

/**
 * Startup recovery. It never contacts OpenRouter: it only inspects the paid
 * lock owner through Phase 7 identity, reconciles attempt-matched orphan files
 * (publishing valid ones, quarantining the rest), and marks a crashed active
 * job interrupted. A live image-job owner or an uncertain owner is left
 * untouched; a live foreign paid owner (for example an agent run) does not
 * block image-state recovery.
 */
export async function recoverInterruptedImageState(
  options: RecoverInterruptedImageStateOptions,
): Promise<ImageRecoveryResult> {
  const { storage } = options;
  const now = options.now ?? new Date();
  const job = await loadImageJob(storage);

  let lockMeta: LockMetadata | null = null;
  try {
    lockMeta = (await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS))) ?? null;
  } catch (error) {
    const result: ImageRecoveryResult = {
      status: "uncertain",
      reconciliation: null,
      jobId: job?.jobId ?? null,
      jobMarked: null,
      lockReleased: false,
      reason: `Paid lock exists but cannot be read safely (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    };
    await writeReport(storage, reportFrom(result, now.toISOString()));
    return result;
  }

  let needsRecoveryLock = lockMeta === null;
  if (lockMeta !== null) {
    const owner = await classifyLockOwner(lockMeta, {
      procRoot: options.procRoot,
    });
    if (owner.state === "uncertain") {
      const result: ImageRecoveryResult = {
        status: "uncertain",
        reconciliation: null,
        jobId: job?.jobId ?? null,
        jobMarked: null,
        lockReleased: false,
        reason: `Paid lock ownership cannot be verified (${owner.reason}).`,
      };
      await writeReport(storage, reportFrom(result, now.toISOString()));
      return result;
    }
    if (owner.state === "active") {
      if (
        job !== undefined &&
        isActiveImageJobStatus(job.status) &&
        lockMeta.ownerId === job.jobId
      ) {
        const result: ImageRecoveryResult = {
          status: "active-owner",
          reconciliation: null,
          jobId: job.jobId,
          jobMarked: null,
          lockReleased: false,
          reason: `Paid lock is held by live image-job owner ${lockMeta.ownerId}.`,
        };
        await writeReport(storage, reportFrom(result, now.toISOString()));
        return result;
      }
      // A live foreign paid owner (for example an agent run) holds the lock,
      // but the image state can still be reconciled without touching it.
      needsRecoveryLock = false;
    } else {
      // A stale foreign lock (for example an abandoned agent run) belongs to
      // its own phase: reclaiming it here could free the paid lock while an
      // orphan browser group is still alive. Agent recovery verifies and
      // terminates that group first.
      needsRecoveryLock = lockMeta.kind === PAID_JOB_LOCK_KIND;
    }
  }

  let lock: OwnerLock | null = null;
  if (needsRecoveryLock) {
    try {
      lock = await acquireLock(storage, PAID_JOB_LOCK_SEGMENTS, {
        kind: PAID_JOB_LOCK_KIND,
        ownerId: `recovery-${randomUUID()}`,
        procRoot: options.procRoot,
        releaseOnExit: true,
      });
    } catch (error) {
      if (error instanceof LockHeldError) {
        const result: ImageRecoveryResult = {
          status: "active-owner",
          reconciliation: null,
          jobId: job?.jobId ?? null,
          jobMarked: null,
          lockReleased: false,
          reason: "A competing process acquired the paid lock during recovery.",
        };
        await writeReport(storage, reportFrom(result, now.toISOString()));
        return result;
      }
      if (error instanceof LockError) throw error;
      throw error;
    }
  }

  let released = false;
  try {
    const reconciliation = await reconcileImages(storage, {
      allowActiveJob: true,
      now,
    });

    const currentJob = await loadImageJob(storage);
    let jobMarked: ImageJobStatus | null = null;
    if (currentJob && isActiveImageJobStatus(currentJob.status)) {
      jobMarked = await markInterruptedJob(storage, currentJob, now);
    }

    if (lock) {
      await lock.release();
      released = true;
    }

    const result: ImageRecoveryResult = {
      status: "reconciled",
      reconciliation,
      jobId: currentJob?.jobId ?? null,
      jobMarked,
      lockReleased: lock !== null,
      reason: null,
    };
    await writeReport(storage, reportFrom(result, now.toISOString()));
    return result;
  } finally {
    if (lock && !released) {
      await lock.release().catch(() => undefined);
    }
  }
}

export type ResumeMode = "missing" | "failed" | "regenerate";

export interface ResumeSuggestion {
  readonly mode: ResumeMode;
  readonly targets: ProductId[];
  readonly missingTargets: ProductId[];
  readonly failedTargets: ProductId[];
  readonly jobId: string | null;
  readonly jobStatus: ImageJobStatus | null;
}

export interface SuggestResumeTargetsOptions {
  readonly productIds?: readonly string[] | undefined;
}

/**
 * Computes the targets a fresh confirmed resume/retry/regenerate may request.
 * "failed" excludes products whose active image is already valid so a
 * reconciliation-rescued image is never re-billed; "regenerate" is the only
 * mode that may target an already valid image, and only explicitly.
 */
export async function suggestResumeTargets(
  storage: Storage,
  mode: ResumeMode,
  options: SuggestResumeTargetsOptions = {},
): Promise<ResumeSuggestion> {
  const job = await loadImageJob(storage);
  const jobId = job?.jobId ?? null;
  const jobStatus = job?.status ?? null;

  const manifest = await loadImageManifest(storage);
  const inspections = await inspectActiveImages(storage, manifest);
  const valid = new Set<string>(
    inspections
      .filter((inspection) => inspection.valid)
      .map((inspection) => inspection.productId),
  );

  const failedTargets = (job?.targets ?? [])
    .filter((target) => target.status === "failed")
    .map((target) => target.productId);
  const missingTargets = products
    .map((product) => product.id)
    .filter((productId) => !valid.has(productId));

  let targets: ProductId[];
  if (mode === "missing") {
    targets = missingTargets;
  } else if (mode === "failed") {
    targets = failedTargets.filter((productId) => !valid.has(productId));
  } else if (mode === "regenerate") {
    const requested = options.productIds ?? [];
    const seen = new Set<string>();
    for (const value of requested) {
      if (!isProductId(value)) {
        throw new ImageRecoveryError(
          `Unknown product ID for regeneration: ${JSON.stringify(value)}.`,
        );
      }
      seen.add(value);
    }
    targets = products
      .map((product) => product.id)
      .filter((productId) => seen.has(productId));
  } else {
    throw new ImageRecoveryError(`Unknown resume mode: ${String(mode)}.`);
  }

  return {
    mode,
    targets,
    missingTargets,
    failedTargets,
    jobId,
    jobStatus,
  };
}
