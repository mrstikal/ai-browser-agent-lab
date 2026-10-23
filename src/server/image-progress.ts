import type { ProductId } from "../lib/products";
import { products } from "../lib/products";
import type { ImageCost, ImageJobStatus } from "./image-state";
import {
  imageCostToMicro,
  inspectActiveImages,
  inspectSetupState,
  loadImageJob,
  loadImageManifest,
  type SetupStatus,
} from "./image-state";
import { getKeyStatus } from "./credentials";
import { formatUsdMicro } from "./usd";
import { loadDeliverableImages, type DeliverableImage } from "./image-delivery";
import { Storage, type StorageEnv } from "./storage";

export const IMAGE_PROGRESS_VERSION = 1;

export interface ImageProgressTarget {
  readonly productId: ProductId;
  readonly name: string;
  readonly status: "queued" | "generating" | "succeeded" | "failed" | "reused";
  readonly attemptId: string | null;
  readonly error: string | null;
  readonly imageUrl: string | null;
  readonly cost: ImageCost | null;
}

export interface ImageProgressPreviewItem {
  readonly productId: ProductId;
  readonly name: string;
  readonly valid: boolean;
  readonly imageUrl: string | null;
}

export interface ImageProgressSnapshot {
  readonly version: typeof IMAGE_PROGRESS_VERSION;
  readonly generatedAt: string;
  readonly preview: readonly ImageProgressPreviewItem[];
  readonly setup: {
    readonly status: SetupStatus;
    readonly validImageCount: number;
    readonly totalImageCount: number;
    readonly missingImageIds: readonly ProductId[];
    readonly invalidActiveImageIds: readonly ProductId[];
    readonly keyAvailable: boolean;
    readonly failedRegeneration: boolean;
  };
  readonly job: {
    readonly jobId: string | null;
    readonly status: ImageJobStatus | null;
    readonly error: string | null;
    readonly stopRequested: boolean;
    readonly createdAt: string | null;
    readonly updatedAt: string | null;
    readonly counts: {
      readonly queued: number;
      readonly generating: number;
      readonly succeeded: number;
      readonly failed: number;
      readonly reused: number;
    };
    readonly targets: readonly ImageProgressTarget[];
  };
  readonly costs: {
    readonly quote: {
      readonly imageCount: number;
      readonly unitPriceUsd: string;
      readonly baseUsd: string;
      readonly worstCaseUsd: string;
      readonly startingBalanceBaseUsd: string;
      readonly startingBalanceWorstCaseUsd: string;
      readonly perRequestFloorUsd: string;
      readonly providerSlug: string;
      readonly fingerprint: string;
    } | null;
    readonly reportedUsd: string;
    readonly estimatedUsd: string;
    readonly unknownAttempts: number;
    readonly totalAttempts: number;
  };
  readonly resume: {
    readonly missingTargets: readonly ProductId[];
    readonly failedTargets: readonly ProductId[];
    readonly retryableTargets: readonly ProductId[];
  };
  readonly error: string | null;
}

export interface LoadImageProgressOptions {
  readonly env?: StorageEnv | undefined;
  readonly now?: Date | undefined;
}

function emptyCosts(): ImageProgressSnapshot["costs"] {
  return {
    quote: null,
    reportedUsd: "0.00",
    estimatedUsd: "0.00",
    unknownAttempts: 0,
    totalAttempts: 0,
  };
}

function emptySnapshot(
  generatedAt: string,
  keyAvailable: boolean,
  error: string,
): ImageProgressSnapshot {
  return {
    version: IMAGE_PROGRESS_VERSION,
    generatedAt,
    preview: products.map((product) => ({
      productId: product.id,
      name: product.name,
      valid: false,
      imageUrl: null,
    })),
    setup: {
      status: "incomplete",
      validImageCount: 0,
      totalImageCount: 24,
      missingImageIds: [],
      invalidActiveImageIds: [],
      keyAvailable,
      failedRegeneration: false,
    },
    job: {
      jobId: null,
      status: null,
      error: null,
      stopRequested: false,
      createdAt: null,
      updatedAt: null,
      counts: { queued: 0, generating: 0, succeeded: 0, failed: 0, reused: 0 },
      targets: [],
    },
    costs: emptyCosts(),
    resume: { missingTargets: [], failedTargets: [], retryableTargets: [] },
    error,
  };
}

/**
 * Read-only progress snapshot for SSE, the GET fallback, and initial server
 * rendering. It never contacts OpenRouter and never starts work.
 */
export async function loadImageProgress(
  storage: Storage,
  options: LoadImageProgressOptions = {},
): Promise<ImageProgressSnapshot> {
  const env = options.env ?? process.env;
  const generatedAt = (options.now ?? new Date()).toISOString();

  let keyAvailable = false;
  try {
    keyAvailable = (await getKeyStatus(env)).keyAvailable;
  } catch {
    keyAvailable = false;
  }

  let delivered: Map<string, DeliverableImage>;
  let manifest;
  try {
    delivered = await loadDeliverableImages(storage);
    manifest = await loadImageManifest(storage);
  } catch {
    return emptySnapshot(generatedAt, keyAvailable, "Image state is unreadable.");
  }

  let job;
  try {
    job = await loadImageJob(storage);
  } catch {
    return emptySnapshot(generatedAt, keyAvailable, "Image job state is unreadable.");
  }

  let setup;
  try {
    setup = await inspectSetupState(storage, { keyAvailable });
  } catch {
    return emptySnapshot(generatedAt, keyAvailable, "Image setup state is unreadable.");
  }

  let activeByProduct: Map<
    ProductId,
    Awaited<ReturnType<typeof inspectActiveImages>>[number]
  >;
  try {
    activeByProduct = new Map(
      (await inspectActiveImages(storage, manifest)).map((inspection) => [
        inspection.productId,
        inspection,
      ]),
    );
  } catch {
    return emptySnapshot(generatedAt, keyAvailable, "Image state is unreadable.");
  }

  const attemptsById = new Map(
    products.flatMap((product) =>
      (manifest.products[product.id]?.attempts ?? []).map((attempt) => [
        attempt.attemptId,
        attempt,
      ]),
    ),
  );

  const valid = new Set<string>(
    [...activeByProduct.values()]
      .filter((inspection) => inspection.valid)
      .map((inspection) => inspection.productId),
  );

  const counts = { queued: 0, generating: 0, succeeded: 0, failed: 0, reused: 0 };
  const targets: ImageProgressTarget[] = [];
  if (job) {
    for (const target of job.targets) {
      counts[target.status] += 1;
      const attempt = target.attemptId
        ? attemptsById.get(target.attemptId)
        : undefined;
      targets.push({
        productId: target.productId,
        name: products.find((product) => product.id === target.productId)?.name ?? target.productId,
        status: target.status,
        attemptId: target.attemptId,
        error: target.error,
        imageUrl: delivered.get(target.productId)?.url ?? null,
        cost: attempt?.cost ?? null,
      });
    }
  }

  let reportedMicro = 0n;
  let estimatedMicro = 0n;
  let unknownAttempts = 0;
  let totalAttempts = 0;
  for (const product of products) {
    for (const attempt of manifest.products[product.id]?.attempts ?? []) {
      totalAttempts += 1;
      const micro = imageCostToMicro(attempt.cost);
      if (micro === null) {
        unknownAttempts += 1;
      } else if (attempt.cost.kind === "reported") {
        reportedMicro += micro;
      } else {
        estimatedMicro += micro;
      }
    }
  }

  const failedTargets = (job?.targets ?? [])
    .filter((target) => target.status === "failed")
    .map((target) => target.productId);

  return {
    version: IMAGE_PROGRESS_VERSION,
    generatedAt,
    preview: products.map((product) => ({
      productId: product.id,
      name: product.name,
      valid: valid.has(product.id),
      imageUrl: delivered.get(product.id)?.url ?? null,
    })),
    setup: {
      status: setup.status,
      validImageCount: setup.validImageCount,
      totalImageCount: setup.totalImageCount,
      missingImageIds: setup.missingImageIds,
      invalidActiveImageIds: setup.invalidActiveImageIds,
      keyAvailable,
      failedRegeneration: setup.job.failedRegeneration,
    },
    job: {
      jobId: job?.jobId ?? null,
      status: job?.status ?? null,
      error: job?.error ?? null,
      stopRequested: job?.stopRequest !== null && job?.stopRequest !== undefined,
      createdAt: job?.createdAt ?? null,
      updatedAt: job?.updatedAt ?? null,
      counts,
      targets,
    },
    costs: {
      quote: job?.quote
        ? {
            imageCount: job.quote.imageCount,
            unitPriceUsd: job.quote.unitPriceUsd,
            baseUsd: job.quote.baseUsd,
            worstCaseUsd: job.quote.worstCaseUsd,
            startingBalanceBaseUsd: job.quote.startingBalanceBaseUsd,
            startingBalanceWorstCaseUsd: job.quote.startingBalanceWorstCaseUsd,
            perRequestFloorUsd: job.quote.perRequestFloorUsd,
            providerSlug: job.quote.providerSlug,
            fingerprint: job.quote.fingerprint,
          }
        : null,
      reportedUsd: formatUsdMicro(reportedMicro),
      estimatedUsd: formatUsdMicro(estimatedMicro),
      unknownAttempts,
      totalAttempts,
    },
    resume: {
      missingTargets: setup.missingImageIds,
      failedTargets,
      retryableTargets: failedTargets.filter(
        (productId) => !valid.has(productId),
      ),
    },
    error: null,
  };
}