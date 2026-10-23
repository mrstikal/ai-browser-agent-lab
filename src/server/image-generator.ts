import { randomUUID } from "node:crypto";
import type { ImageModelSelection } from "../lib/schemas";
import type { ProductId } from "../lib/products";
import {
  appendStartedAttempt,
  loadImageManifest,
  markAttemptFailed,
  publishAttempt,
  saveImageManifest,
  withImageManifestLock,
  type ImageCost,
  type ImageManifest,
} from "./image-state";
import {
  buildAttemptFilename,
  MAX_IMAGE_BYTES,
  validateImageBytes,
  type ValidatedImage,
} from "./image-validation";
import {
  normalizeOpenRouterKey,
  openRouterEndpoint,
  postOpenRouterJson,
  resolveOpenRouterBaseUrl,
} from "./openrouter";
import { Storage, StorageExistsError, type StorageEnv } from "./storage";
import { parseUsdToMicro } from "./usd";

export const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_IMAGE_RESPONSE_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_LENGTH = 2000;

export type ImageGenerationFailureCode =
  | "unauthorized"
  | "insufficient-credit"
  | "rate-limited"
  | "provider-error"
  | "network"
  | "timeout"
  | "invalid-response"
  | "image-invalid"
  | "format-mismatch"
  | "provider-mismatch"
  | "file-exists";

export interface ImageGenerationSuccess {
  readonly status: "succeeded";
  readonly productId: ProductId;
  readonly attemptId: string;
  readonly filename: string;
  readonly image: ValidatedImage;
  readonly cost: ImageCost;
  readonly httpStatus: 200;
}

export interface ImageGenerationFailure {
  readonly status: "failed";
  readonly productId: ProductId;
  readonly attemptId: string;
  readonly code: ImageGenerationFailureCode;
  readonly message: string;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
}

export type ImageGenerationResult =
  | ImageGenerationSuccess
  | ImageGenerationFailure;

export class ImageGeneratorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageGeneratorError";
  }
}

export interface GenerateOneImageOptions {
  readonly storage: Storage;
  readonly productId: ProductId;
  readonly prompt: string;
  readonly apiKey: string;
  readonly selection: ImageModelSelection;
  readonly providerOnly: readonly string[];
  readonly attemptId?: string | undefined;
  readonly estimatedUnitPriceUsd?: string | undefined;
  readonly env?: StorageEnv | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly now?: Date | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Image(value: unknown): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  if (cleaned.length === 0 || cleaned.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return undefined;
  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
    return undefined;
  }
  if (buffer.toString("base64") !== cleaned) return undefined;
  return buffer;
}

function costFromUsage(usage: unknown): ImageCost | undefined {
  if (!isRecord(usage)) return undefined;
  const cost = usage.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return undefined;
  }
  return { kind: "reported", usd: cost };
}

function estimatedCost(value: string | undefined): ImageCost {
  if (value === undefined) return { kind: "unknown" };
  try {
    const micro = parseUsdToMicro(value);
    return { kind: "estimated", usd: Number(micro) / 1_000_000 };
  } catch {
    return { kind: "unknown" };
  }
}

async function candidateFilenames(
  storage: Storage,
  productId: ProductId,
  attemptId: string,
): Promise<string[]> {
  const names = [
    buildAttemptFilename(productId, attemptId, "png"),
    buildAttemptFilename(productId, attemptId, "jpeg"),
    buildAttemptFilename(productId, attemptId, "webp"),
  ];
  const existing: string[] = [];
  for (const name of names) {
    if ((await storage.readFile(["images", name])) !== undefined) {
      existing.push(name);
    }
  }
  return existing;
}

/**
 * One-image OpenRouter adapter. It records the started attempt before the
 * request, pins the quoted provider, validates the decoded image, writes a
 * unique per-attempt filename, and only then publishes the active pointer.
 * Every failure marks the attempt failed and leaves any earlier active image
 * untouched. It never deletes or overwrites an existing image file.
 */
export async function generateOneImage(
  options: GenerateOneImageOptions,
): Promise<ImageGenerationResult> {
  const prompt = options.prompt?.trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    throw new ImageGeneratorError(
      `Prompt must be 1-${MAX_PROMPT_LENGTH} characters.`,
    );
  }
  let apiKey: string;
  try {
    apiKey = normalizeOpenRouterKey(options.apiKey);
  } catch (error) {
    throw new ImageGeneratorError(
      "The API key format is not acceptable.",
      { cause: error },
    );
  }

  if (
    options.providerOnly.length > 5 ||
    options.providerOnly.some(
      (provider) =>
        typeof provider !== "string" ||
        provider.length === 0 ||
        provider.length > 64 ||
        /[\u0000-\u001f\u007f]/.test(provider),
    )
  ) {
    throw new ImageGeneratorError("The provider pin is not valid.");
  }

  const env = options.env ?? process.env;
  // Fails closed before anything is recorded or sent, so a production key can
  // never be routed to a loopback mock override outside explicit test mode.
  const baseUrl = resolveOpenRouterBaseUrl(env);

  const attemptId = options.attemptId ?? randomUUID();
  const now = options.now ?? new Date();
  const storage = options.storage;

  return withImageManifestLock(storage, () =>
    generateOneImageLocked({
      options,
      prompt,
      apiKey,
      baseUrl,
      attemptId,
      now,
    }),
  );
}

async function generateOneImageLocked(input: {
  readonly options: GenerateOneImageOptions;
  readonly prompt: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly attemptId: string;
  readonly now: Date;
}): Promise<ImageGenerationResult> {
  const { options, prompt, apiKey, baseUrl, attemptId, now } = input;
  const storage = options.storage;

  const existingFiles = await candidateFilenames(
    storage,
    options.productId,
    attemptId,
  );
  const manifest = await loadImageManifest(storage);
  let withStarted;
  try {
    withStarted = appendStartedAttempt(manifest, options.productId, attemptId, {
      startedAt: now,
    });
  } catch (error) {
    throw new ImageGeneratorError("The image attempt could not be started.", {
      cause: error,
    });
  }
  await saveImageManifest(storage, withStarted);

  if (existingFiles.length > 0) {
    return failAttempt({
      storage,
      manifest: withStarted,
      productId: options.productId,
      attemptId,
      now,
      code: "file-exists",
      httpStatus: null,
      message: `An image file for this attempt already exists (${existingFiles[0]}). Run startup reconciliation instead of overwriting it.`,
    });
  }

  const requestBody: Record<string, unknown> = {
    model: options.selection.modelId,
    prompt,
    n: 1,
    resolution: options.selection.resolution,
    aspect_ratio: options.selection.aspectRatio,
    output_format: options.selection.format,
  };
  if (options.providerOnly.length > 0) {
    requestBody.provider = { only: [...options.providerOnly] };
  }

  const fetched = await postOpenRouterJson(
    openRouterEndpoint(baseUrl, "images"),
    requestBody,
    {
      headers: { authorization: `Bearer ${apiKey}` },
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_IMAGE_REQUEST_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_IMAGE_RESPONSE_MAX_BYTES,
    },
  );

  if (!fetched.ok) {
    if (fetched.kind === "http") {
      const retryAfterSeconds = fetched.retryAfterSeconds;
      if (fetched.status === 401) {
        return failAttempt({
          storage,
          manifest: withStarted,
          productId: options.productId,
          attemptId,
          now,
          code: "unauthorized",
          httpStatus: 401,
          retryAfterSeconds,
          message:
            "OpenRouter rejected the key. This rejection is not expected to be billed and nothing was published.",
        });
      }
      if (fetched.status === 402) {
        return failAttempt({
          storage,
          manifest: withStarted,
          productId: options.productId,
          attemptId,
          now,
          code: "insufficient-credit",
          httpStatus: 402,
          retryAfterSeconds,
          message:
            "OpenRouter returned 402: the account balance is below the $1 per-request floor. This rejection is not billed and nothing was published.",
        });
      }
      if (fetched.status === 429) {
        return failAttempt({
          storage,
          manifest: withStarted,
          productId: options.productId,
          attemptId,
          now,
          code: "rate-limited",
          httpStatus: 429,
          retryAfterSeconds,
          message:
          "OpenRouter rate-limited the request. This rejection is not expected to be billed and nothing was published.",
        });
      }
      return failAttempt({
        storage,
        manifest: withStarted,
        productId: options.productId,
        attemptId,
        now,
        code: "provider-error",
        httpStatus: fetched.status,
        retryAfterSeconds,
        message: "The image provider returned an error. Nothing was published.",
      });
    }
    if (fetched.kind === "timeout") {
      return failAttempt({
        storage,
        manifest: withStarted,
        productId: options.productId,
        attemptId,
        now,
        code: "timeout",
        httpStatus: null,
        message:
          "The request timed out. The provider may still charge for this attempt; cost stays unknown and a bounded retry may follow.",
      });
    }
    if (fetched.kind === "network") {
      return failAttempt({
        storage,
        manifest: withStarted,
        productId: options.productId,
        attemptId,
        now,
        code: "network",
        httpStatus: null,
        message:
          "The provider could not be reached. The attempt may still be charged; cost stays unknown.",
      });
    }
    return failAttempt({
      storage,
      manifest: withStarted,
      productId: options.productId,
      attemptId,
      now,
      code: "invalid-response",
      httpStatus: null,
      message: "The provider response could not be parsed. Nothing was published.",
    });
  }

  const parsed = fetched.json;
  const responseProvider =
    isRecord(parsed) && typeof parsed.provider === "string"
      ? parsed.provider
      : null;
  if (
    responseProvider !== null &&
    options.providerOnly.length > 0 &&
    !options.providerOnly.includes(responseProvider)
  ) {
    return failAttempt({
      storage,
      manifest: withStarted,
      productId: options.productId,
      attemptId,
      now,
      code: "provider-mismatch",
      httpStatus: 200,
      message:
        "The provider response came from an endpoint outside the confirmed quote. Nothing was published.",
    });
  }
  const data = isRecord(parsed) ? parsed.data : undefined;
  const first = Array.isArray(data) && data.length > 0 ? data[0] : undefined;
  if (!isRecord(first)) {
    return failAttempt({
      storage,
      manifest: withStarted,
      productId: options.productId,
      attemptId,
      now,
      code: "invalid-response",
      httpStatus: 200,
      message: "The provider response did not contain image data. Nothing was published.",
    });
  }

  const bytes = decodeBase64Image(first.b64_json);
  if (!bytes) {
    return failAttempt({
      storage,
      manifest: withStarted,
      productId: options.productId,
      attemptId,
      now,
      code: "invalid-response",
      httpStatus: 200,
      message: "The provider image data was malformed. Nothing was published.",
    });
  }

  let filename: string;
  let image: ValidatedImage;
  try {
    image = validateImageBytes(bytes);
    if (image.format !== options.selection.format) {
      return failAttempt({
        storage,
        manifest: withStarted,
        productId: options.productId,
        attemptId,
        now,
        code: "format-mismatch",
        httpStatus: 200,
        message: `The provider returned ${image.mediaType} instead of the requested ${options.selection.format}. Nothing was published.`,
      });
    }
    const mediaType = first.media_type;
    if (typeof mediaType === "string" && mediaType !== image.mediaType) {
      return failAttempt({
        storage,
        manifest: withStarted,
        productId: options.productId,
        attemptId,
        now,
        code: "format-mismatch",
        httpStatus: 200,
        message: "The provider media type did not match the image bytes. Nothing was published.",
      });
    }
    filename = buildAttemptFilename(
      options.productId,
      attemptId,
      image.format,
    );
    image = validateImageBytes(bytes, { filename });
  } catch (error) {
    return failAttempt({
      storage,
      manifest: withStarted,
      productId: options.productId,
      attemptId,
      now,
      code: "image-invalid",
      httpStatus: 200,
      message: `The returned image did not pass validation (${
        error instanceof Error ? error.message : "unknown reason"
      }). Nothing was published.`,
    });
  }

  try {
    await storage.writeFileExclusive(["images", filename], bytes);
  } catch (error) {
    if (error instanceof StorageExistsError) {
      return failAttempt({
        storage,
        manifest: withStarted,
        productId: options.productId,
        attemptId,
        now,
        code: "file-exists",
        httpStatus: 200,
        message: `The target file ${filename} already exists and was not overwritten.`,
      });
    }
    throw error;
  }

  const cost =
    costFromUsage(isRecord(parsed) ? parsed.usage : undefined) ??
    estimatedCost(options.estimatedUnitPriceUsd);
  const published = publishAttempt(withStarted, options.productId, attemptId, {
    filename,
    validation: image,
    publishedAt: now,
    finishedAt: now,
    cost,
  });
  await saveImageManifest(storage, published);

  return {
    status: "succeeded",
    productId: options.productId,
    attemptId,
    filename,
    image,
    cost,
    httpStatus: 200,
  };
}

async function failAttempt(options: {
  readonly storage: Storage;
  readonly manifest: ImageManifest;
  readonly productId: ProductId;
  readonly attemptId: string;
  readonly now: Date;
  readonly code: ImageGenerationFailureCode;
  readonly httpStatus: number | null;
  readonly message: string;
  readonly retryAfterSeconds?: number | null | undefined;
}): Promise<ImageGenerationFailure> {
  const failed = markAttemptFailed(
    options.manifest,
    options.productId,
    options.attemptId,
    {
      finishedAt: options.now,
      error: options.message,
    },
  );
  await saveImageManifest(options.storage, failed);
  return {
    status: "failed",
    productId: options.productId,
    attemptId: options.attemptId,
    code: options.code,
    httpStatus: options.httpStatus,
    retryAfterSeconds: options.retryAfterSeconds ?? null,
    message: options.message,
  };
}
