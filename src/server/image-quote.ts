import { createHash } from "node:crypto";
import {
  imageModelSettingsSchema,
  QUOTE_ATTEMPTS_PER_IMAGE,
  type ImageModelSelection,
} from "../lib/schemas";
import type { ProductId } from "../lib/products";
import {
  fetchImageModelCapabilities,
  type ImageModelCapabilities,
} from "./image-catalog";
import {
  inspectActiveImages,
  loadImageManifest,
  PRODUCT_IDS,
} from "./image-state";
import { isProductId } from "./image-validation";
import { loadModelSettings } from "./model-settings";
import { Storage, type StorageEnv } from "./storage";
import { formatUsdMicro, parseUsdToMicro } from "./usd";

export { QUOTE_ATTEMPTS_PER_IMAGE };
export const QUOTE_PER_REQUEST_FLOOR_USD = "1.00";

export type ImageQuoteIntent = "missing" | "resume" | "regenerate";

export type ImageQuoteCode =
  | "no-targets"
  | "invalid-selection"
  | "invalid-settings"
  | "invalid-image-state"
  | "key-required"
  | "key-rejected"
  | "stale-model"
  | "unverified-capabilities"
  | "unknown-price"
  | "unavailable"
  | "invalid-response";

export class ImageQuoteError extends Error {
  readonly code: ImageQuoteCode;
  readonly httpStatus: number | null;
  readonly reason: "network" | "timeout" | null;

  constructor(
    code: ImageQuoteCode,
    message: string,
    options: {
      readonly httpStatus?: number | null;
      readonly reason?: "network" | "timeout" | null;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ImageQuoteError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.reason = options.reason ?? null;
  }
}

export interface ImageQuote {
  readonly targets: readonly ProductId[];
  readonly imageCount: number;
  readonly attemptsPerImage: number;
  readonly selection: ImageModelSelection;
  readonly providerSlug: string;
  readonly providerTag: string;
  readonly providerOnly: readonly string[];
  readonly unitPriceUsd: string;
  readonly baseUsd: string;
  readonly worstCaseUsd: string;
  readonly startingBalanceBaseUsd: string;
  readonly startingBalanceWorstCaseUsd: string;
  readonly perRequestFloorUsd: string;
  readonly fingerprint: string;
}

function quoteFingerprint(input: {
  readonly selection: ImageModelSelection;
  readonly providerSlug: string;
  readonly providerTag: string;
  readonly unitPriceUsd: string;
  readonly targets: readonly ProductId[];
  readonly intent: ImageQuoteIntent;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

/**
 * Exact decimal quote: base cost for one attempt per target, the three-attempt
 * worst case, and the indicative starting balance that keeps the per-request
 * floor available before every request. No per-image rounding.
 */
export function computeImageQuote(
  targets: readonly ProductId[],
  capabilities: ImageModelCapabilities,
  intent: ImageQuoteIntent = "regenerate",
): ImageQuote {
  if (targets.length === 0) {
    throw new ImageQuoteError("no-targets", "Choose at least one image to generate.");
  }

  let unitMicro: bigint;
  try {
    unitMicro = parseUsdToMicro(capabilities.unitPriceUsd);
  } catch (error) {
    throw new ImageQuoteError(
      "unknown-price",
      "The verified endpoint returned a price that cannot be used for an exact quote.",
      { cause: error },
    );
  }

  const imageCount = BigInt(targets.length);
  const attempts = BigInt(QUOTE_ATTEMPTS_PER_IMAGE);
  const floorMicro = parseUsdToMicro(QUOTE_PER_REQUEST_FLOOR_USD);
  const baseMicro = unitMicro * imageCount;
  const worstCaseMicro = baseMicro * attempts;
  const startingBalanceBaseMicro = floorMicro + unitMicro * (imageCount - 1n);
  const startingBalanceWorstCaseMicro =
    floorMicro + unitMicro * (imageCount * attempts - 1n);

  const selection = imageModelSettingsSchema.parse({
    modelId: capabilities.modelId,
    resolution: capabilities.resolution,
    aspectRatio: capabilities.aspectRatio,
    format: capabilities.format,
    n: 1,
  });

  return {
    targets: [...targets],
    imageCount: targets.length,
    attemptsPerImage: QUOTE_ATTEMPTS_PER_IMAGE,
    selection,
    providerSlug: capabilities.providerSlug,
    providerTag: capabilities.providerTag,
    providerOnly: [capabilities.providerTag],
    unitPriceUsd: formatUsdMicro(unitMicro),
    baseUsd: formatUsdMicro(baseMicro),
    worstCaseUsd: formatUsdMicro(worstCaseMicro),
    startingBalanceBaseUsd: formatUsdMicro(startingBalanceBaseMicro),
    startingBalanceWorstCaseUsd: formatUsdMicro(startingBalanceWorstCaseMicro),
    perRequestFloorUsd: QUOTE_PER_REQUEST_FLOOR_USD,
    fingerprint: quoteFingerprint({
      selection,
      providerSlug: capabilities.providerSlug,
      providerTag: capabilities.providerTag,
      unitPriceUsd: formatUsdMicro(unitMicro),
      targets,
      intent,
    }),
  };
}

export function isImageQuoteCurrent(
  accepted: ImageQuote,
  fresh: ImageQuote,
): boolean {
  return accepted.fingerprint === fresh.fingerprint;
}

function normalizeSelectedIds(selectedIds: readonly string[]): ProductId[] {
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (!isProductId(id)) {
      throw new ImageQuoteError(
        "invalid-selection",
        `Unknown product ID for regeneration: ${JSON.stringify(id)}.`,
      );
    }
    seen.add(id);
  }
  return PRODUCT_IDS.filter((productId) => seen.has(productId));
}

async function missingTargets(storage: Storage): Promise<ProductId[]> {
  const manifest = await loadImageManifest(storage);
  const inspections = await inspectActiveImages(storage, manifest);
  const valid = new Set<string>(
    inspections.filter((inspection) => inspection.valid).map((inspection) => inspection.productId),
  );
  return PRODUCT_IDS.filter((productId) => !valid.has(productId));
}

export interface PrepareImageQuoteOptions {
  readonly storage: Storage;
  readonly apiKey: string | undefined;
  readonly selection?: ImageModelSelection | undefined;
  readonly selectedIds?: readonly string[] | undefined;
  /**
   * `resume` re-filters selected IDs against the current missing set, so a
   * confirmation from another tab cannot pay to regenerate an image that has
   * since become valid. `regenerate` is an explicit paid overwrite.
   */
  readonly intent?: ImageQuoteIntent | undefined;
  readonly env?: StorageEnv | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
}

/**
 * Builds the current quote using only metadata GETs. It never issues a paid
 * image request; a failed capability or price check rejects the quote.
 */
export async function prepareImageQuote(
  options: PrepareImageQuoteOptions,
): Promise<ImageQuote> {
  let settings;
  try {
    settings = await loadModelSettings(options.storage);
  } catch (error) {
    throw new ImageQuoteError(
      "invalid-settings",
      "Model settings are unreadable; inspect settings.json before quoting.",
      { cause: error },
    );
  }

  let selection: ImageModelSelection;
  if (options.selection !== undefined) {
    const parsed = imageModelSettingsSchema.safeParse(options.selection);
    if (!parsed.success) {
      throw new ImageQuoteError(
        "invalid-selection",
        "The requested image model selection is not valid.",
        { cause: parsed.error },
      );
    }
    selection = parsed.data;
  } else {
    selection = settings.image;
  }

  const intent: ImageQuoteIntent =
    options.intent ??
    (options.selectedIds !== undefined ? "regenerate" : "missing");
  let targets: ProductId[];
  if (intent === "missing") {
    if (options.selectedIds !== undefined) {
      throw new ImageQuoteError(
        "invalid-selection",
        "The missing-image quote does not accept explicit image IDs.",
      );
    }
    try {
      targets = await missingTargets(options.storage);
    } catch (error) {
      throw new ImageQuoteError(
        "invalid-image-state",
        "Saved image state is unreadable; inspect the image manifest before quoting.",
        { cause: error },
      );
    }
  } else {
    if (options.selectedIds === undefined) {
      throw new ImageQuoteError(
        "invalid-selection",
        `${intent === "resume" ? "A resume" : "A regeneration"} quote needs explicit image IDs.`,
      );
    }
    targets = normalizeSelectedIds(options.selectedIds);
    if (intent === "resume") {
      let missing: ProductId[];
      try {
        missing = await missingTargets(options.storage);
      } catch (error) {
        throw new ImageQuoteError(
          "invalid-image-state",
          "Saved image state is unreadable; inspect the image manifest before quoting.",
          { cause: error },
        );
      }
      const stillMissing = new Set<string>(missing);
      targets = targets.filter((productId) => stillMissing.has(productId));
      if (targets.length === 0) {
        throw new ImageQuoteError(
          "no-targets",
          "All selected images are already valid; no paid resume is needed.",
        );
      }
    }
  }
  if (targets.length === 0) {
    throw new ImageQuoteError("no-targets", "No missing or selected images to quote.");
  }

  const capabilities = await fetchImageModelCapabilities(selection, {
    apiKey: options.apiKey,
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
  });
  if (capabilities.status !== "verified") {
    if (capabilities.status === "unavailable") {
      throw new ImageQuoteError(
        "unavailable",
        "Image model metadata is unavailable right now; no paid request was made.",
        { httpStatus: capabilities.httpStatus, reason: capabilities.reason },
      );
    }
    if (capabilities.status === "invalid-response") {
      throw new ImageQuoteError(
        "invalid-response",
        "Image model metadata could not be verified; no paid request was made.",
      );
    }
    throw new ImageQuoteError(
      capabilities.status,
      `Image model capabilities cannot be verified (${capabilities.status}); no paid request was made.`,
    );
  }

  return computeImageQuote(targets, capabilities.capabilities, intent);
}
