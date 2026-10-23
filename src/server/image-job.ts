import { randomUUID } from "node:crypto";
import {
  ImageQuoteError,
  prepareImageQuote,
  type ImageQuote,
  type ImageQuoteCode,
} from "./image-quote";
import {
  createImageJobSnapshot,
  isActiveImageJobStatus,
  loadImageJob,
  saveImageJob,
  type ImageJobQuote,
  type ImageJobSnapshot,
} from "./image-state";
import { acquireLock, LockError, LockHeldError, type OwnerLock } from "./lock";
import {
  beginPaidOperation,
  endPaidOperation,
  PaidOperationActiveError,
} from "./paid-operation";
import { Storage, type StorageEnv } from "./storage";

export const PAID_JOB_LOCK_SEGMENTS = ["locks", "paid-job.lock"] as const;
export const PAID_JOB_LOCK_KIND = "paid-job";

export type StartImageJobResult =
  | { readonly status: "started"; readonly job: ImageJobSnapshot }
  | { readonly status: "existing"; readonly job: ImageJobSnapshot }
  | { readonly status: "quote-changed"; readonly quote: ImageQuote }
  | { readonly status: "job-active"; readonly job: ImageJobSnapshot | null }
  | { readonly status: "paid-operation-active" }
  | {
      readonly status: "quote-rejected";
      readonly code: ImageQuoteCode;
      readonly message: string;
    }
  | {
      readonly status: "unavailable";
      readonly httpStatus: number | null;
      readonly reason: "network" | "timeout" | null;
    }
  | { readonly status: "lock-error"; readonly message: string };

export interface StartImageJobOptions {
  readonly storage: Storage;
  readonly apiKey: string;
  readonly fingerprint: string;
  readonly selection?: ImageQuote["selection"] | undefined;
  readonly selectedIds?: readonly string[] | undefined;
  readonly env?: StorageEnv | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: Date | undefined;
}

export type StopImageJobReason =
  | "no-job"
  | "wrong-job"
  | "finished"
  | "duplicate";

export type StopImageJobResult =
  | { readonly applied: true; readonly job: ImageJobSnapshot }
  | {
      readonly applied: false;
      readonly reason: StopImageJobReason;
      readonly job: ImageJobSnapshot | null;
    };

const IMAGE_JOB_HOLDER_KEY = Symbol.for(
  "ai-browser-agent-lab.image-job-holder",
);

interface AdmittedJob {
  readonly jobId: string;
  readonly lock: OwnerLock;
}

interface ImageJobHolder {
  readonly jobs: Map<string, AdmittedJob>;
}

function holder(): ImageJobHolder {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[IMAGE_JOB_HOLDER_KEY] as ImageJobHolder | undefined;
  if (existing) return existing;
  const created: ImageJobHolder = { jobs: new Map() };
  host[IMAGE_JOB_HOLDER_KEY] = created;
  return created;
}

const JOB_QUEUES = new Map<string, Promise<void>>();

function withImageJobLock<T>(
  storage: Storage,
  task: () => Promise<T>,
): Promise<T> {
  const key = storage.root;
  const previous = JOB_QUEUES.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  JOB_QUEUES.set(key, settled);
  void settled.finally(() => {
    if (JOB_QUEUES.get(key) === settled) JOB_QUEUES.delete(key);
  });
  return run;
}

function jobQuote(quote: ImageQuote): ImageJobQuote {
  return {
    fingerprint: quote.fingerprint,
    selection: quote.selection,
    providerSlug: quote.providerSlug,
    providerTag: quote.providerTag,
    providerOnly: [...quote.providerOnly],
    unitPriceUsd: quote.unitPriceUsd,
    baseUsd: quote.baseUsd,
    worstCaseUsd: quote.worstCaseUsd,
    startingBalanceBaseUsd: quote.startingBalanceBaseUsd,
    startingBalanceWorstCaseUsd: quote.startingBalanceWorstCaseUsd,
    perRequestFloorUsd: quote.perRequestFloorUsd,
    attemptsPerImage: quote.attemptsPerImage,
    imageCount: quote.imageCount,
  };
}

async function releaseAdmission(
  jobId: string,
  lock: OwnerLock,
): Promise<boolean> {
  try {
    await lock.release();
  } catch {
    return false;
  }
  endPaidOperation(jobId);
  return true;
}

/**
 * Admission only: acquires the shared paid-job lock with the new job UUID as
 * the Phase 7 owner identity, then rechecks the accepted quote under that lock.
 * A changed quote releases the lock without persisting a job or making a paid
 * request. The lock stays held for the Phase 15 worker and is released by
 * releaseAdmittedImageJob (or process exit).
 */
export async function startImageJob(
  options: StartImageJobOptions,
): Promise<StartImageJobResult> {
  return withImageJobLock(options.storage, () => startImageJobLocked(options));
}

async function startImageJobLocked(
  options: StartImageJobOptions,
): Promise<StartImageJobResult> {
  const storage = options.storage;
  const admitted = holder().jobs.get(storage.root);
  if (admitted) {
    const job = await loadImageJob(storage);
    if (!job || job.jobId !== admitted.jobId) {
      return { status: "job-active", job: job ?? null };
    }
    if (job.quote?.fingerprint === options.fingerprint) {
      return { status: "existing", job };
    }
    return { status: "job-active", job };
  }

  const persisted = await loadImageJob(storage);
  if (persisted && isActiveImageJobStatus(persisted.status)) {
    return { status: "job-active", job: persisted };
  }

  const jobId = randomUUID();
  let lock: OwnerLock;
  try {
    lock = await acquireLock(storage, PAID_JOB_LOCK_SEGMENTS, {
      kind: PAID_JOB_LOCK_KIND,
      ownerId: jobId,
      releaseOnExit: true,
    });
  } catch (error) {
    if (error instanceof LockHeldError) return { status: "paid-operation-active" };
    if (error instanceof LockError) {
      return { status: "lock-error", message: error.message };
    }
    throw error;
  }

  try {
    try {
      beginPaidOperation(jobId, PAID_JOB_LOCK_KIND);
    } catch (error) {
      if (error instanceof PaidOperationActiveError) {
        if (!(await releaseAdmission(jobId, lock))) {
          return {
            status: "lock-error",
            message:
              "The paid-job lock could not be released safely; inspect data/locks/paid-job.lock.",
          };
        }
        return { status: "paid-operation-active" };
      }
      throw error;
    }

    let quote: ImageQuote;
    try {
      quote = await prepareImageQuote({
        storage,
        apiKey: options.apiKey,
        selection: options.selection,
        selectedIds: options.selectedIds,
        env: options.env,
        fetchImpl: options.fetchImpl,
      });
    } catch (error) {
      const released = await releaseAdmission(jobId, lock);
      if (!released) {
        return {
          status: "lock-error",
          message:
            "The paid-job lock could not be released safely; inspect data/locks/paid-job.lock.",
        };
      }
      if (error instanceof ImageQuoteError) {
        if (error.code === "unavailable") {
          return {
            status: "unavailable",
            httpStatus: error.httpStatus,
            reason: error.reason,
          };
        }
        return {
          status: "quote-rejected",
          code: error.code,
          message: error.message,
        };
      }
      throw error;
    }

    if (quote.fingerprint !== options.fingerprint) {
      if (!(await releaseAdmission(jobId, lock))) {
        return {
          status: "lock-error",
          message:
            "The paid-job lock could not be released safely; inspect data/locks/paid-job.lock.",
        };
      }
      return { status: "quote-changed", quote };
    }

    const base = createImageJobSnapshot({
      jobId,
      productIds: quote.targets,
      now: options.now,
    });
    const job: ImageJobSnapshot = { ...base, quote: jobQuote(quote) };
    await saveImageJob(storage, job);
    holder().jobs.set(storage.root, { jobId, lock });
    return { status: "started", job };
  } catch (error) {
    await releaseAdmission(jobId, lock);
    throw error;
  }
}

/**
 * Idempotent, job-ID-scoped persisted stop request. A wrong or terminal job ID
 * never touches the current file. Does not abort an in-flight request and does
 * not release the paid lock; the worker settles it.
 */
export async function requestImageJobStop(options: {
  readonly storage: Storage;
  readonly jobId: string;
  readonly now?: Date | undefined;
}): Promise<StopImageJobResult> {
  // Deliberately not serialized behind admission: a stop must persist promptly
  // even while a start quote recheck is waiting on provider metadata. The job
  // file write is atomic and job-ID checked.
  const job = await loadImageJob(options.storage);
  if (!job) return { applied: false, reason: "no-job", job: null };
  if (job.jobId !== options.jobId) {
    return { applied: false, reason: "wrong-job", job: null };
  }
  if (!isActiveImageJobStatus(job.status)) {
    return { applied: false, reason: "finished", job };
  }
  if (job.stopRequest !== null) {
    return { applied: false, reason: "duplicate", job };
  }

  const now = options.now ?? new Date();
  const updated: ImageJobSnapshot = {
    ...job,
    status: "stopping",
    stopRequest: { jobId: job.jobId, requestedAt: now.toISOString() },
    updatedAt: now.toISOString(),
  };
  await saveImageJob(options.storage, updated);
  return { applied: true, job: updated };
}

/**
 * Releases an admitted job's paid lock and in-process paid-operation marker.
 * Phase 15 calls this after the final job snapshot is persisted.
 */
export async function releaseAdmittedImageJob(options: {
  readonly storage: Storage;
  readonly jobId: string;
}): Promise<boolean> {
  return withImageJobLock(options.storage, async () => {
    const state = holder();
    const admitted = state.jobs.get(options.storage.root);
    if (!admitted || admitted.jobId !== options.jobId) return false;
    if (!(await releaseAdmission(admitted.jobId, admitted.lock))) {
      return false;
    }
    state.jobs.delete(options.storage.root);
    return true;
  });
}

export function admittedImageJobId(storage: Storage): string | null {
  return holder().jobs.get(storage.root)?.jobId ?? null;
}

// Test-only: releases and clears all in-process admissions for this process.
export async function resetAdmittedImageJobsForTests(): Promise<void> {
  const state = holder();
  const jobs = [...state.jobs.values()];
  state.jobs.clear();
  for (const job of jobs) {
    await releaseAdmission(job.jobId, job.lock);
  }
}
