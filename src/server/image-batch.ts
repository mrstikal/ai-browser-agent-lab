import { randomUUID } from "node:crypto";
import { products } from "../lib/products";
import type { ProductId } from "../lib/products";
import {
  generateOneImage,
  type ImageGenerationResult,
} from "./image-generator";
import {
  inspectActiveImages,
  loadImageJob,
  loadImageManifest,
  type ImageJobSnapshot,
  type ImageJobTarget,
} from "./image-state";
import { releaseAdmittedImageJob, updateImageJob } from "./image-job";
import { Storage, type StorageEnv } from "./storage";

export const MAX_TARGET_ERROR_LENGTH = 500;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 8000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_CONFIGURED_RETRIES = 10;

export class ImageBatchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageBatchConfigError";
  }
}

const BATCH_HOLDER_KEY = Symbol.for("ai-browser-agent-lab.image-batch-holder");

interface BatchController {
  readonly jobId: string;
  readonly promise: Promise<void>;
}

interface BatchHolder {
  readonly controllers: Map<string, BatchController>;
}

function holder(): BatchHolder {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[BATCH_HOLDER_KEY] as BatchHolder | undefined;
  if (existing) return existing;
  const created: BatchHolder = { controllers: new Map() };
  host[BATCH_HOLDER_KEY] = created;
  return created;
}

export interface ImageRetryPolicy {
  readonly baseDelayMs?: number | undefined;
  readonly maxDelayMs?: number | undefined;
  readonly maxRetries?: number | undefined;
}

export interface StartImageBatchOptions {
  readonly storage: Storage;
  readonly jobId: string;
  readonly apiKey: string;
  readonly env?: StorageEnv | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly retry?: ImageRetryPolicy | undefined;
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Starts (or joins) the sequential worker for an admitted job. The controller
 * lives in a globalThis holder so HMR or a duplicate start cannot run two
 * workers for the same job. The returned promise settles when the batch has
 * reached a terminal job status and released the paid lock.
 */
export function startImageBatch(options: StartImageBatchOptions): Promise<void> {
  const state = holder();
  const key = options.storage.root;
  const existing = state.controllers.get(key);
  if (existing) {
    if (existing.jobId === options.jobId) return existing.promise;
    // The lock can be free while the previous controller is still settling.
    // Chain instead of clobbering so the new job's worker actually runs.
    return existing.promise.then(() => startImageBatch(options));
  }

  const promise = runImageBatch(options).finally(() => {
    const current = state.controllers.get(key);
    if (current && current.jobId === options.jobId) {
      state.controllers.delete(key);
    }
  });
  state.controllers.set(key, { jobId: options.jobId, promise });
  return promise;
}

export function activeImageBatchJobId(storage: Storage): string | null {
  return holder().controllers.get(storage.root)?.jobId ?? null;
}

export function awaitImageBatch(storage: Storage): Promise<void> {
  return holder().controllers.get(storage.root)?.promise ?? Promise.resolve();
}

function withTarget(
  job: ImageJobSnapshot,
  productId: ProductId,
  changes: Partial<ImageJobTarget>,
): ImageJobSnapshot {
  return {
    ...job,
    targets: job.targets.map((target) =>
      target.productId === productId ? { ...target, ...changes } : target,
    ),
  };
}

function promptFor(productId: ProductId): string {
  const product = products.find((candidate) => candidate.id === productId);
  if (!product) throw new Error(`Unknown product ID: ${productId}.`);
  return product.imagePrompt;
}

function truncateError(message: string): string {
  return message.length > MAX_TARGET_ERROR_LENGTH
    ? message.slice(0, MAX_TARGET_ERROR_LENGTH)
    : message;
}

function resolveRetryPolicy(policy: ImageRetryPolicy | undefined): {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetries: number;
} {
  if (policy === undefined) {
    return {
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
    };
  }
  for (const [label, value] of [
    ["baseDelayMs", policy.baseDelayMs],
    ["maxDelayMs", policy.maxDelayMs],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new ImageBatchConfigError(`${label} must be a positive integer.`);
    }
  }
  if (
    policy.maxRetries !== undefined &&
    (!Number.isInteger(policy.maxRetries) ||
      policy.maxRetries < 0 ||
      policy.maxRetries > MAX_CONFIGURED_RETRIES)
  ) {
    throw new ImageBatchConfigError(
      `maxRetries must be an integer between 0 and ${MAX_CONFIGURED_RETRIES}.`,
    );
  }
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  if (baseDelayMs > maxDelayMs) {
    throw new ImageBatchConfigError("baseDelayMs must not exceed maxDelayMs.");
  }
  return {
    baseDelayMs,
    maxDelayMs,
    maxRetries: policy.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

function isRetryableFailure(result: {
  readonly code: string;
  readonly httpStatus: number | null;
}): boolean {
  if (
    result.code === "network" ||
    result.code === "timeout" ||
    result.code === "rate-limited"
  ) {
    return true;
  }
  return (
    result.code === "provider-error" &&
    result.httpStatus !== null &&
    result.httpStatus >= 500
  );
}

function retryDelayMs(
  failedAttempt: number,
  retryAfterSeconds: number | null,
  policy: { readonly baseDelayMs: number; readonly maxDelayMs: number },
): number {
  const backoff = Math.min(
    policy.baseDelayMs * 2 ** (failedAttempt - 1),
    policy.maxDelayMs,
  );
  const retryAfter = retryAfterSeconds === null ? 0 : retryAfterSeconds * 1000;
  return Math.min(Math.max(backoff, retryAfter), policy.maxDelayMs);
}

function isFatalFailure(result: {
  readonly code: string;
  readonly httpStatus: number | null;
}): boolean {
  // Deterministic authorization, billing, or model-configuration problems:
  // repeating them would only spend more money for the same failure.
  if (
    result.code === "unauthorized" ||
    result.code === "insufficient-credit" ||
    result.code === "provider-mismatch" ||
    result.code === "unsupported-format" ||
    result.code === "format-mismatch" ||
    result.code === "file-exists"
  ) {
    return true;
  }
  const fatalProviderStatuses = new Set([400, 403, 404, 413, 422]);
  return (
    result.code === "provider-error" &&
    result.httpStatus !== null &&
    fatalProviderStatuses.has(result.httpStatus)
  );
}

async function finalize(
  storage: Storage,
  jobId: string,
  status: "completed" | "failed" | "stopped_by_user",
  error: string | null,
  now: Date,
): Promise<void> {
  await updateImageJob(
    storage,
    jobId,
    (current) => ({ ...current, status, error, stopRequest: current.stopRequest }),
    now,
  );
  // Whether or not the snapshot survived, this admission no longer owns a
  // worker and must not keep the paid lock.
  await releaseAdmittedImageJob({ storage, jobId }).catch(() => undefined);
}

async function releaseWithoutFinalStatus(
  storage: Storage,
  jobId: string,
): Promise<void> {
  await releaseAdmittedImageJob({ storage, jobId }).catch(() => undefined);
}

async function finalizeCompleted(
  storage: Storage,
  jobId: string,
  now: Date,
): Promise<void> {
  const manifest = await loadImageManifest(storage);
  const inspections = await inspectActiveImages(storage, manifest);
  const validCount = inspections.filter((inspection) => inspection.valid).length;
  if (validCount === 24 && inspections.length === 24) {
    await finalize(storage, jobId, "completed", null, now);
    return;
  }
  await finalize(
    storage,
    jobId,
    "failed",
    `The batch finished but only ${validCount} of 24 images validate.`,
    now,
  );
}

async function runImageBatch(options: StartImageBatchOptions): Promise<void> {
  const { storage, jobId, apiKey } = options;
  const now = () => new Date();
  let currentProductId: ProductId | null = null;

  try {
    const initial = await loadImageJob(storage);
    if (!initial || initial.jobId !== jobId) {
      await releaseWithoutFinalStatus(storage, jobId);
      return;
    }
    if (initial.stopRequest !== null) {
      await finalize(storage, jobId, "stopped_by_user", null, now());
      return;
    }
    if (initial.quote === null) {
      await finalize(
        storage,
        jobId,
        "failed",
        "The admitted job has no persisted quote; no request was sent.",
        now(),
      );
      return;
    }

    const quote = initial.quote;
    const targetIds = initial.targets.map((target) => target.productId);
    const policy = resolveRetryPolicy(options.retry);
    const sleep =
      options.sleepImpl ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const running = await updateImageJob(
      storage,
      jobId,
      (current) => ({ ...current, status: "running" }),
      now(),
    );
    if (!running) {
      await releaseWithoutFinalStatus(storage, jobId);
      return;
    }

    for (const productId of targetIds) {
      currentProductId = productId;
      const beforeRequest = await loadImageJob(storage);
      if (!beforeRequest || beforeRequest.jobId !== jobId) {
        await releaseWithoutFinalStatus(storage, jobId);
        return;
      }
      if (beforeRequest.stopRequest !== null) {
        await finalize(storage, jobId, "stopped_by_user", null, now());
        return;
      }
      const target = beforeRequest.targets.find(
        (candidate) => candidate.productId === productId,
      );
      if (!target || (target.status !== "queued" && target.status !== "generating")) {
        continue;
      }

      const generating = await updateImageJob(
        storage,
        jobId,
        (current) =>
          withTarget(current, productId, { status: "generating", error: null }),
        now(),
      );
      if (!generating) {
        await releaseWithoutFinalStatus(storage, jobId);
        return;
      }

      let attemptNumber = 0;
      let result: ImageGenerationResult | undefined;
      for (;;) {
        attemptNumber += 1;
        const stopBeforeAttempt = await loadImageJob(storage);
        if (!stopBeforeAttempt || stopBeforeAttempt.jobId !== jobId) {
          await releaseWithoutFinalStatus(storage, jobId);
          return;
        }
        if (stopBeforeAttempt.stopRequest !== null) {
          await updateImageJob(
            storage,
            jobId,
            (current) =>
              withTarget(
                current,
                productId,
                result && result.status === "failed"
                  ? {
                      status: "failed",
                      attemptId: result.attemptId,
                      error: truncateError(result.message),
                    }
                  : {
                      status: "failed",
                      error: "Stopped before this target was attempted.",
                    },
              ),
            now(),
          ).catch(() => undefined);
          await finalize(storage, jobId, "stopped_by_user", null, now());
          return;
        }

        result = await generateOneImage({
          storage,
          productId,
          prompt: promptFor(productId),
          apiKey,
          selection: quote.selection,
          providerOnly: quote.providerOnly,
          attemptId: randomUUID(),
          estimatedUnitPriceUsd: quote.unitPriceUsd,
          env: options.env,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
        });

        if (
          result.status === "succeeded" ||
          !isRetryableFailure(result) ||
          attemptNumber > policy.maxRetries
        ) {
          break;
        }

        // Transient failure: record it on the target, back off, and retry
        // unless a stop lands first. Each attempt is a separate manifest
        // attempt, so retry charges stay visible in the lifetime ledger.
        const recorded = await updateImageJob(
          storage,
          jobId,
          (current) =>
            withTarget(current, productId, {
              status: "generating",
              attemptId: result && result.status === "failed" ? result.attemptId : null,
              error:
                result && result.status === "failed"
                  ? truncateError(result.message)
                  : null,
            }),
          now(),
        );
        if (!recorded) {
          await releaseWithoutFinalStatus(storage, jobId);
          return;
        }
        const delay = retryDelayMs(
          attemptNumber,
          result.status === "failed" ? result.retryAfterSeconds : null,
          policy,
        );
        await sleep(delay);
      }

      if (!result) {
        await releaseWithoutFinalStatus(storage, jobId);
        return;
      }

      const updated = await updateImageJob(
        storage,
        jobId,
        (current) =>
          withTarget(
            current,
            productId,
            result.status === "succeeded"
              ? { status: "succeeded", attemptId: result.attemptId, error: null }
              : {
                  status: "failed",
                  attemptId: result.attemptId,
                  error: truncateError(result.message),
                },
          ),
        now(),
      );
      if (!updated) {
        await releaseWithoutFinalStatus(storage, jobId);
        return;
      }
      currentProductId = null;

      // Re-read after the serialized write: a stop recorded while the request
      // was in flight wins, and the loop must send no next paid request.
      const stopCheck = await loadImageJob(storage);
      if (!stopCheck || stopCheck.jobId !== jobId) {
        await releaseWithoutFinalStatus(storage, jobId);
        return;
      }
      if (stopCheck.stopRequest !== null) {
        await finalize(storage, jobId, "stopped_by_user", null, now());
        return;
      }
      if (result.status === "failed" && isFatalFailure(result)) {
        await finalize(
          storage,
          jobId,
          "failed",
          `Stopped after ${result.code}; no further requests were sent.`,
          now(),
        );
        return;
      }
    }

    currentProductId = null;
    const completed = await loadImageJob(storage);
    if (!completed || completed.jobId !== jobId) {
      await releaseWithoutFinalStatus(storage, jobId);
      return;
    }
    if (completed.stopRequest !== null) {
      await finalize(storage, jobId, "stopped_by_user", null, now());
      return;
    }
    if (completed.targets.some((target) => target.status !== "succeeded")) {
      const failed = completed.targets.filter(
        (target) => target.status === "failed",
      ).length;
      await finalize(
        storage,
        jobId,
        "failed",
        `${failed} of ${completed.targets.length} targets failed.`,
        now(),
      );
      return;
    }
    await finalizeCompleted(storage, jobId, now());
  } catch {
    if (currentProductId !== null) {
      await updateImageJob(
        storage,
        jobId,
        (current) =>
          withTarget(current, currentProductId as ProductId, {
            status: "failed",
            error: "The attempt stopped unexpectedly. Published images were kept.",
          }),
        now(),
      ).catch(() => undefined);
    }
    try {
      await finalize(
        storage,
        jobId,
        "failed",
        "The batch stopped unexpectedly. Previously published images were kept.",
        now(),
      );
    } catch {
      await releaseWithoutFinalStatus(storage, jobId);
    }
  }
}
