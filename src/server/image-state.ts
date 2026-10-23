import { randomUUID } from "node:crypto";
import { link, lstat, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  imageModelSettingsSchema,
  QUOTE_ATTEMPTS_PER_IMAGE,
  type ImageModelSelection,
} from "../lib/schemas";
import { products, type ProductId } from "../lib/products";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  buildAttemptFilename,
  extensionForFormat,
  isProductId,
  isUuid,
  mediaTypeForFormat,
  ImageValidationError,
  parseImageFilename,
  validateImageBytes,
  type ImageFormat,
  type ValidatedImage,
} from "./image-validation";
import { Storage, StorageCorruptionError } from "./storage";
import { formatUsdMicro, parseUsdToMicro } from "./usd";

export const IMAGE_MANIFEST_VERSION = 1;
export const IMAGE_JOB_VERSION = 1;
export const MANIFEST_SEGMENTS = ["images", "manifest.json"] as const;
export const JOB_SEGMENTS = ["image-job.json"] as const;

export const PRODUCT_IDS: readonly ProductId[] = products.map(
  (product) => product.id,
);
const PRODUCT_ID_SET = new Set<string>(PRODUCT_IDS);

export type ImageAttemptStatus = "started" | "succeeded" | "failed" | "interrupted";

export type ImageCost =
  | { readonly kind: "reported"; readonly usd: number }
  | { readonly kind: "estimated"; readonly usd: number }
  | { readonly kind: "unknown" };

export interface ImageAttempt {
  readonly attemptId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: ImageAttemptStatus;
  readonly filename: string | null;
  readonly format: ImageFormat | null;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly cost: ImageCost;
  readonly error: string | null;
}

export interface PublishedImage {
  readonly attemptId: string;
  readonly filename: string;
  readonly format: ImageFormat;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly publishedAt: string;
}

export interface ProductImageState {
  readonly active: PublishedImage | null;
  readonly attempts: ImageAttempt[];
}

export interface ImageManifest {
  readonly version: typeof IMAGE_MANIFEST_VERSION;
  readonly updatedAt: string;
  readonly products: Record<ProductId, ProductImageState>;
}

export type ImageJobStatus =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped_by_user";

export type ImageJobTargetStatus =
  | "queued"
  | "generating"
  | "succeeded"
  | "failed"
  | "reused";

export interface ImageJobTarget {
  readonly productId: ProductId;
  readonly status: ImageJobTargetStatus;
  readonly attemptId: string | null;
  readonly error: string | null;
}

export interface ImageJobStopRequest {
  readonly jobId: string;
  readonly requestedAt: string;
}

export interface ImageJobQuote {
  readonly fingerprint: string;
  readonly selection: ImageModelSelection;
  readonly providerSlug: string;
  readonly providerTag: string | null;
  readonly providerOnly: string[];
  readonly unitPriceUsd: string;
  readonly baseUsd: string;
  readonly worstCaseUsd: string;
  readonly startingBalanceBaseUsd: string;
  readonly startingBalanceWorstCaseUsd: string;
  readonly perRequestFloorUsd: string;
  readonly attemptsPerImage: number;
  readonly imageCount: number;
}

export interface ImageJobSnapshot {
  readonly version: typeof IMAGE_JOB_VERSION;
  readonly jobId: string;
  readonly status: ImageJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targets: ImageJobTarget[];
  readonly stopRequest: ImageJobStopRequest | null;
  readonly quote: ImageJobQuote | null;
  readonly error: string | null;
}

export type SetupStatus =
  | "generating"
  | "stopping"
  | "completed"
  | "incomplete"
  | "not_configured"
  | "ready_to_generate";

export interface SetupState {
  readonly status: SetupStatus;
  readonly keyAvailable: boolean;
  readonly validImageIds: readonly ProductId[];
  readonly missingImageIds: readonly ProductId[];
  readonly invalidActiveImageIds: readonly ProductId[];
  readonly validImageCount: number;
  readonly totalImageCount: number;
  readonly job: {
    readonly jobId: string | null;
    readonly status: ImageJobStatus | null;
    readonly isLive: boolean;
    readonly failedRegeneration: boolean;
  };
}

export interface ActiveImageInspection {
  readonly productId: ProductId;
  readonly filename: string;
  readonly valid: boolean;
  readonly reason: string | null;
  readonly image: ValidatedImage | null;
}

export interface ReconcileResult {
  readonly manifest: ImageManifest;
  readonly activeImages: readonly ActiveImageInspection[];
  readonly reconciled: readonly {
    readonly productId: ProductId;
    readonly attemptId: string;
    readonly filename: string;
  }[];
  readonly quarantined: readonly {
    readonly filename: string;
    readonly reason: string;
    readonly movedTo: string | null;
    readonly error: string | null;
  }[];
  readonly interruptedAttempts: readonly {
    readonly productId: ProductId;
    readonly attemptId: string;
  }[];
}

export interface DeriveSetupStateInput {
  readonly keyAvailable: boolean;
  readonly manifest: ImageManifest;
  readonly validImageIds: readonly ProductId[];
  readonly job?: ImageJobSnapshot | undefined;
  readonly jobIsLive?: boolean | undefined;
}

const MANIFEST_QUEUES = new Map<string, Promise<void>>();

/**
 * Serializes manifest read-modify-write operations per data root so a caller
 * can never publish a pre-request snapshot over another writer's attempt
 * records. Reentrant use inside the same task is not supported.
 */
export function withImageManifestLock<T>(
  storage: Storage,
  task: () => Promise<T>,
): Promise<T> {
  const key = storage.root;
  const previous = MANIFEST_QUEUES.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  MANIFEST_QUEUES.set(key, settled);
  void settled.finally(() => {
    if (MANIFEST_QUEUES.get(key) === settled) {
      MANIFEST_QUEUES.delete(key);
    }
  });
  return run;
}

export class ImageStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageStateError";
  }
}

export class ImageStateCorruptionError extends StorageCorruptionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageStateCorruptionError";
  }
}

function corrupted(message: string): never {
  throw new ImageStateCorruptionError(`Image state is invalid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function readIsoTimestamp(value: unknown, label: string): string {
  if (!isIsoTimestamp(value)) corrupted(`${label} must be an ISO timestamp.`);
  return value;
}

function readString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    corrupted(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function readNullableString(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return readString(value, label, maxLength);
}

function readInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    corrupted(`${label} must be an integer in ${minimum}..${maximum}.`);
  }
  return value as number;
}

function readNullableInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return null;
  return readInteger(value, label, minimum, maximum);
}

function readFormat(value: unknown, label: string): ImageFormat {
  if (value !== "png" && value !== "jpeg" && value !== "webp") {
    corrupted(`${label} must be png, jpeg, or webp.`);
  }
  return value;
}

function readNullableFormat(
  value: unknown,
  label: string,
): ImageFormat | null {
  if (value === null) return null;
  return readFormat(value, label);
}

function readHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    corrupted(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

function readNullableHash(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readHash(value, label);
}

export function parseImageCost(value: unknown): ImageCost {
  if (!isRecord(value)) corrupted("cost must be an object.");
  if (value.kind === "unknown") return { kind: "unknown" };
  if (value.kind === "reported" || value.kind === "estimated") {
    if (
      typeof value.usd !== "number" ||
      !Number.isFinite(value.usd) ||
      value.usd < 0
    ) {
      corrupted("cost.usd must be a finite non-negative number.");
    }
    return { kind: value.kind, usd: value.usd };
  }
  return corrupted("cost.kind must be reported, estimated, or unknown.");
}

function validateAttemptFilename(
  filename: string | null,
  productId: ProductId,
  attemptId: string,
  format: ImageFormat | null,
): void {
  if (filename === null) return;
  const parsed = parseImageFilename(filename);
  if (
    !parsed ||
    parsed.productId !== productId ||
    parsed.attemptId !== attemptId ||
    (format !== null && parsed.format !== format)
  ) {
    corrupted(
      `attempt filename ${JSON.stringify(filename)} does not match product ${productId}, attempt ${attemptId}, and its format.`,
    );
  }
}

function parseAttempt(
  value: unknown,
  productId: ProductId,
): ImageAttempt {
  if (!isRecord(value)) corrupted("attempt must be an object.");
  const attemptId = value.attemptId;
  if (!isUuid(attemptId)) corrupted("attempt.attemptId must be a UUID.");
  const startedAt = readIsoTimestamp(value.startedAt, "attempt.startedAt");
  const finishedAt =
    value.finishedAt === null
      ? null
      : readIsoTimestamp(value.finishedAt, "attempt.finishedAt");
  if (
    finishedAt !== null &&
    Date.parse(finishedAt) < Date.parse(startedAt)
  ) {
    corrupted("attempt.finishedAt cannot precede attempt.startedAt.");
  }

  const status = value.status;
  if (
    status !== "started" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "interrupted"
  ) {
    corrupted("attempt.status is invalid.");
  }

  const filename = readNullableString(value.filename, "attempt.filename", 200);
  const format = readNullableFormat(value.format, "attempt.format");
  const mediaType = readNullableString(value.mediaType, "attempt.mediaType", 64);
  const sizeBytes = readNullableInteger(
    value.sizeBytes,
    "attempt.sizeBytes",
    1,
    MAX_IMAGE_BYTES,
  );
  const sha256 = readNullableHash(value.sha256, "attempt.sha256");
  const width = readNullableInteger(
    value.width,
    "attempt.width",
    1,
    MAX_IMAGE_DIMENSION,
  );
  const height = readNullableInteger(
    value.height,
    "attempt.height",
    1,
    MAX_IMAGE_DIMENSION,
  );
  const cost = parseImageCost(value.cost);
  const error = readNullableString(value.error, "attempt.error", 2000);
  validateAttemptFilename(filename, productId, attemptId, format);

  if (status === "started") {
    if (
      finishedAt !== null ||
      filename !== null ||
      format !== null ||
      mediaType !== null ||
      sizeBytes !== null ||
      sha256 !== null ||
      width !== null ||
      height !== null
    ) {
      corrupted("started attempts cannot have a finished time or file metadata.");
    }
  }

  if (status === "succeeded") {
    if (
      finishedAt === null ||
      filename === null ||
      format === null ||
      mediaType === null ||
      sizeBytes === null ||
      sha256 === null ||
      width === null ||
      height === null
    ) {
      corrupted("succeeded attempts require finished time and complete file metadata.");
    }
    if (mediaType !== mediaTypeForFormat(format)) {
      corrupted("succeeded attempt mediaType does not match its format.");
    }
  }

  if ((status === "failed" || status === "interrupted") && finishedAt === null) {
    corrupted(`${status} attempts require a finished time.`);
  }

  if (format !== null && mediaType !== null && mediaType !== mediaTypeForFormat(format)) {
    corrupted("attempt mediaType does not match its format.");
  }

  return {
    attemptId,
    startedAt,
    finishedAt,
    status,
    filename,
    format,
    mediaType,
    sizeBytes,
    sha256,
    width,
    height,
    cost,
    error,
  };
}

function parsePublishedImage(
  value: unknown,
  productId: ProductId,
  attempts: readonly ImageAttempt[],
): PublishedImage {
  if (!isRecord(value)) corrupted("active image must be an object or null.");
  const attemptId = value.attemptId;
  if (!isUuid(attemptId)) corrupted("active.attemptId must be a UUID.");
  const filename = readString(value.filename, "active.filename", 200);
  const format = readFormat(value.format, "active.format");
  const mediaType = readString(value.mediaType, "active.mediaType", 64);
  if (mediaType !== mediaTypeForFormat(format)) {
    corrupted("active mediaType does not match its format.");
  }
  const sizeBytes = readInteger(
    value.sizeBytes,
    "active.sizeBytes",
    1,
    MAX_IMAGE_BYTES,
  );
  const sha256 = readHash(value.sha256, "active.sha256");
  const width = readInteger(value.width, "active.width", 1, MAX_IMAGE_DIMENSION);
  const height = readInteger(
    value.height,
    "active.height",
    1,
    MAX_IMAGE_DIMENSION,
  );
  const publishedAt = readIsoTimestamp(value.publishedAt, "active.publishedAt");
  validateAttemptFilename(filename, productId, attemptId, format);

  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!attempt || attempt.status !== "succeeded") {
    corrupted("active image must reference a succeeded attempt.");
  }
  if (
    attempt.filename !== filename ||
    attempt.format !== format ||
    attempt.mediaType !== mediaType ||
    attempt.sizeBytes !== sizeBytes ||
    attempt.sha256 !== sha256 ||
    attempt.width !== width ||
    attempt.height !== height
  ) {
    corrupted("active image metadata does not match its attempt.");
  }
  if (Date.parse(publishedAt) < Date.parse(attempt.finishedAt ?? attempt.startedAt)) {
    corrupted("active.publishedAt cannot precede the attempt finish time.");
  }

  return {
    attemptId,
    filename,
    format,
    mediaType,
    sizeBytes,
    sha256,
    width,
    height,
    publishedAt,
  };
}

function parseProductImageState(
  value: unknown,
  productId: ProductId,
): ProductImageState {
  if (!isRecord(value)) corrupted(`products.${productId} must be an object.`);
  if (!Array.isArray(value.attempts)) {
    corrupted(`products.${productId}.attempts must be an array.`);
  }

  if (value.attempts.length > 10_000) {
    corrupted(`products.${productId}.attempts exceeds the supported bound.`);
  }
  const attempts = value.attempts.map((attempt) =>
    parseAttempt(attempt, productId),
  );
  const attemptIds = new Set<string>();
  let startedCount = 0;
  for (const attempt of attempts) {
    if (attemptIds.has(attempt.attemptId)) {
      corrupted(`duplicate attempt ID ${attempt.attemptId}.`);
    }
    attemptIds.add(attempt.attemptId);
    if (attempt.status === "started") startedCount += 1;
  }
  if (startedCount > 1) {
    corrupted(`products.${productId} has more than one started attempt.`);
  }

  const active =
    value.active === null
      ? null
      : parsePublishedImage(value.active, productId, attempts);

  return { active, attempts };
}

export function parseImageManifest(value: unknown): ImageManifest {
  if (!isRecord(value)) corrupted("manifest must be an object.");
  if (value.version !== IMAGE_MANIFEST_VERSION) {
    corrupted(`unsupported manifest version ${String(value.version)}.`);
  }
  const updatedAt = readIsoTimestamp(value.updatedAt, "manifest.updatedAt");
  if (!isRecord(value.products)) corrupted("manifest.products must be an object.");

  for (const productId of Object.keys(value.products)) {
    if (!isProductId(productId)) {
      corrupted(`unknown product ID ${JSON.stringify(productId)}.`);
    }
  }

  const productStates = {} as Record<ProductId, ProductImageState>;
  const attemptIds = new Set<string>();
  const filenames = new Set<string>();
  for (const productId of PRODUCT_IDS) {
    const raw = value.products[productId];
    const state =
      raw === undefined
        ? { active: null, attempts: [] }
        : parseProductImageState(raw, productId);
    for (const attempt of state.attempts) {
      if (attemptIds.has(attempt.attemptId)) {
        corrupted(`duplicate attempt ID ${attempt.attemptId} across products.`);
      }
      attemptIds.add(attempt.attemptId);
      if (attempt.filename !== null) {
        if (filenames.has(attempt.filename)) {
          corrupted(`duplicate image filename ${attempt.filename}.`);
        }
        filenames.add(attempt.filename);
      }
    }
    productStates[productId] = state;
  }

  return {
    version: IMAGE_MANIFEST_VERSION,
    updatedAt,
    products: productStates,
  };
}

export function createEmptyImageManifest(now: Date = new Date()): ImageManifest {
  const productsState = {} as Record<ProductId, ProductImageState>;
  for (const productId of PRODUCT_IDS) {
    productsState[productId] = { active: null, attempts: [] };
  }
  return {
    version: IMAGE_MANIFEST_VERSION,
    updatedAt: now.toISOString(),
    products: productsState,
  };
}

export async function loadImageManifest(
  storage: Storage,
): Promise<ImageManifest> {
  let raw: unknown;
  try {
    raw = await storage.readJson<unknown>(MANIFEST_SEGMENTS);
  } catch (error) {
    if (error instanceof StorageCorruptionError) {
      throw new ImageStateCorruptionError(
        "The image manifest contains malformed JSON. Inspect it manually; no data was changed.",
        { cause: error },
      );
    }
    throw error;
  }
  if (raw === undefined) return createEmptyImageManifest();
  return parseImageManifest(raw);
}

export async function saveImageManifest(
  storage: Storage,
  manifest: ImageManifest,
): Promise<void> {
  const normalized = parseImageManifest(manifest);
  await storage.writeJson(MANIFEST_SEGMENTS, normalized);
}

function cloneManifest(manifest: ImageManifest): ImageManifest {
  return structuredClone(manifest);
}

function productState(
  manifest: ImageManifest,
  productId: ProductId,
): ProductImageState {
  const state = manifest.products[productId];
  if (!state) {
    throw new ImageStateError(`Unknown product ID: ${productId}.`);
  }
  return state;
}

function attemptFor(
  manifest: ImageManifest,
  productId: ProductId,
  attemptId: string,
): ImageAttempt {
  const attempt = productState(manifest, productId).attempts.find(
    (candidate) => candidate.attemptId === attemptId,
  );
  if (!attempt) {
    throw new ImageStateError(
      `Attempt ${attemptId} does not exist for product ${productId}.`,
    );
  }
  return attempt;
}

export interface AppendStartedAttemptOptions {
  readonly startedAt?: Date;
  readonly cost?: ImageCost;
}

export function appendStartedAttempt(
  manifest: ImageManifest,
  productId: ProductId,
  attemptId: string,
  options: AppendStartedAttemptOptions = {},
): ImageManifest {
  if (!PRODUCT_ID_SET.has(productId)) {
    throw new ImageStateError(`Unknown product ID: ${String(productId)}.`);
  }
  if (!isUuid(attemptId)) {
    throw new ImageStateError(`Invalid attempt ID: ${String(attemptId)}.`);
  }
  const draft = cloneManifest(manifest);
  const state = productState(draft, productId);
  if (state.attempts.some((attempt) => attempt.attemptId === attemptId)) {
    throw new ImageStateError(`Attempt ${attemptId} already exists.`);
  }
  if (state.attempts.some((attempt) => attempt.status === "started")) {
    throw new ImageStateError(
      `Product ${productId} already has a started attempt.`,
    );
  }
  const startedAt = (options.startedAt ?? new Date()).toISOString();
  state.attempts.push({
    attemptId,
    startedAt,
    finishedAt: null,
    status: "started",
    filename: null,
    format: null,
    mediaType: null,
    sizeBytes: null,
    sha256: null,
    width: null,
    height: null,
    cost: options.cost ? parseImageCost(options.cost) : { kind: "unknown" },
    error: null,
  });
  return {
    ...draft,
    updatedAt: new Date().toISOString(),
  };
}

export interface PublishAttemptOptions {
  readonly filename: string;
  readonly validation: ValidatedImage;
  readonly publishedAt?: Date;
  readonly finishedAt?: Date;
  readonly cost?: ImageCost;
}

export function publishAttempt(
  manifest: ImageManifest,
  productId: ProductId,
  attemptId: string,
  options: PublishAttemptOptions,
): ImageManifest {
  const draft = cloneManifest(manifest);
  const state = productState(draft, productId);
  const attempt = attemptFor(draft, productId, attemptId);
  if (attempt.status !== "started" && attempt.status !== "succeeded") {
    throw new ImageStateError(
      `Cannot publish attempt ${attemptId} with status ${attempt.status}.`,
    );
  }

  const parsed = parseImageFilename(options.filename);
  if (
    !parsed ||
    parsed.productId !== productId ||
    parsed.attemptId !== attemptId ||
    parsed.format !== options.validation.format
  ) {
    throw new ImageStateError(
      `Filename ${options.filename} does not match product ${productId}, attempt ${attemptId}, and validated format ${options.validation.format}.`,
    );
  }
  if (options.validation.mediaType !== mediaTypeForFormat(options.validation.format)) {
    throw new ImageStateError("Validated media type does not match its format.");
  }

  const finishedAtDate = options.finishedAt ?? options.publishedAt ?? new Date();
  const finishedAt = finishedAtDate.toISOString();
  const publishedAtDate =
    options.publishedAt !== undefined &&
    options.publishedAt.getTime() >= finishedAtDate.getTime()
      ? options.publishedAt
      : finishedAtDate;
  const publishedAt = publishedAtDate.toISOString();
  if (Date.parse(finishedAt) < Date.parse(attempt.startedAt)) {
    throw new ImageStateError("Attempt cannot finish before it started.");
  }
  if (Date.parse(publishedAt) < Date.parse(attempt.startedAt)) {
    throw new ImageStateError("Attempt cannot be published before it started.");
  }

  const succeeded: ImageAttempt = {
    ...attempt,
    finishedAt,
    status: "succeeded",
    filename: options.filename,
    format: options.validation.format,
    mediaType: options.validation.mediaType,
    sizeBytes: options.validation.sizeBytes,
    sha256: options.validation.sha256,
    width: options.validation.width,
    height: options.validation.height,
    cost: options.cost ? parseImageCost(options.cost) : attempt.cost,
    error: null,
  };
  const index = state.attempts.findIndex(
    (candidate) => candidate.attemptId === attemptId,
  );
  state.attempts[index] = succeeded;
  const active: PublishedImage = {
    attemptId,
    filename: options.filename,
    format: options.validation.format,
    mediaType: options.validation.mediaType,
    sizeBytes: options.validation.sizeBytes,
    sha256: options.validation.sha256,
    width: options.validation.width,
    height: options.validation.height,
    publishedAt,
  };
  (state as { active: PublishedImage | null }).active = active;

  return { ...draft, updatedAt: new Date().toISOString() };
}

export interface FinishAttemptOptions {
  readonly error: string;
  readonly finishedAt?: Date;
  readonly cost?: ImageCost;
}

function finishAttempt(
  manifest: ImageManifest,
  productId: ProductId,
  attemptId: string,
  status: "failed" | "interrupted",
  options: FinishAttemptOptions,
): ImageManifest {
  const draft = cloneManifest(manifest);
  const state = productState(draft, productId);
  const attempt = attemptFor(draft, productId, attemptId);
  if (attempt.status !== "started") {
    throw new ImageStateError(
      `Cannot mark attempt ${attemptId} ${status} from status ${attempt.status}.`,
    );
  }
  const finishedAt = (options.finishedAt ?? new Date()).toISOString();
  if (Date.parse(finishedAt) < Date.parse(attempt.startedAt)) {
    throw new ImageStateError("Attempt cannot finish before it started.");
  }
  const updated: ImageAttempt = {
    ...attempt,
    status,
    finishedAt,
    error: options.error,
    cost: options.cost ? parseImageCost(options.cost) : attempt.cost,
  };
  const index = state.attempts.findIndex(
    (candidate) => candidate.attemptId === attemptId,
  );
  state.attempts[index] = updated;
  return { ...draft, updatedAt: new Date().toISOString() };
}

export function markAttemptFailed(
  manifest: ImageManifest,
  productId: ProductId,
  attemptId: string,
  options: FinishAttemptOptions,
): ImageManifest {
  return finishAttempt(manifest, productId, attemptId, "failed", options);
}

export function markAttemptInterrupted(
  manifest: ImageManifest,
  productId: ProductId,
  attemptId: string,
  options: FinishAttemptOptions,
): ImageManifest {
  return finishAttempt(manifest, productId, attemptId, "interrupted", options);
}

export async function inspectActiveImages(
  storage: Storage,
  manifest: ImageManifest,
): Promise<ActiveImageInspection[]> {
  const inspections: ActiveImageInspection[] = [];
  for (const productId of PRODUCT_IDS) {
    const active = manifest.products[productId]?.active ?? null;
    if (!active) continue;

    let bytes: Buffer | undefined;
    try {
      bytes = await storage.readFile(["images", active.filename]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      inspections.push({
        productId,
        filename: active.filename,
        valid: false,
        reason: code ? `unreadable (${code})` : "unreadable",
        image: null,
      });
      continue;
    }
    if (bytes === undefined) {
      inspections.push({
        productId,
        filename: active.filename,
        valid: false,
        reason: "active image file is missing",
        image: null,
      });
      continue;
    }

    let image: ValidatedImage;
    try {
      image = validateImageBytes(bytes, { filename: active.filename });
    } catch (error) {
      inspections.push({
        productId,
        filename: active.filename,
        valid: false,
        reason: `invalid image: ${
          error instanceof ImageValidationError ? error.message : "validation failed"
        }`,
        image: null,
      });
      continue;
    }

    const mismatch =
      image.format !== active.format ||
      image.mediaType !== active.mediaType ||
      image.sizeBytes !== active.sizeBytes ||
      image.sha256 !== active.sha256 ||
      image.width !== active.width ||
      image.height !== active.height;
    inspections.push({
      productId,
      filename: active.filename,
      valid: !mismatch,
      reason: mismatch ? "active image metadata does not match the manifest" : null,
      image: mismatch ? null : image,
    });
  }
  return inspections;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

interface ImageFileEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

async function listImageFiles(storage: Storage): Promise<ImageFileEntry[]> {
  const dir = await storage.ensureDir(["images"]);
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ImageFileEntry[] = [];
  for (const entry of entries) {
    if (
      entry.name === "orphans" ||
      entry.name === "manifest.json" ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const target = storage.path(["images", entry.name]);
    try {
      const info = await lstat(target);
      files.push({ name: entry.name, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function orphanCandidate(name: string, attempt: number): string {
  if (attempt === 0) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${stem}-${randomUUID()}${extension}`;
}

async function linkNoReplace(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EPERM" ||
      code === "ENOTSUP" ||
      code === "EOPNOTSUPP" ||
      code === "EXDEV"
    ) {
      if (await pathExists(destination)) {
        const conflict = new Error("destination exists") as NodeJS.ErrnoException;
        conflict.code = "EEXIST";
        throw conflict;
      }
      await rename(source, destination);
      return;
    }
    throw error;
  }
}

async function quarantineFile(
  storage: Storage,
  name: string,
): Promise<{ movedTo: string | null; error: string | null }> {
  const orphans = await storage.ensureDir(["images", "orphans"]);
  const source = storage.path(["images", name]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const destinationName = orphanCandidate(name, attempt);
    const destination = join(orphans, destinationName);
    try {
      await linkNoReplace(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if (isNotFound(error)) return { movedTo: null, error: "file disappeared" };
      return {
        movedTo: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      await unlink(source);
      return { movedTo: destinationName, error: null };
    } catch (error) {
      return {
        movedTo: destinationName,
        error: `quarantined copy exists, but the source could not be removed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return {
    movedTo: null,
    error: "could not allocate a unique orphan name",
  };
}

function referencedFilenames(manifest: ImageManifest): Set<string> {
  const referenced = new Set<string>();
  for (const productId of PRODUCT_IDS) {
    const state = manifest.products[productId];
    if (!state) continue;
    if (state.active) referenced.add(state.active.filename);
    for (const attempt of state.attempts) {
      if (attempt.filename !== null) referenced.add(attempt.filename);
    }
  }
  return referenced;
}

export interface ReconcileOptions {
  readonly now?: Date;
  readonly allowActiveJob?: boolean;
}

function finishTimeAtOrAfter(startedAt: string, now: Date): Date {
  const started = Date.parse(startedAt);
  return now.getTime() < started ? new Date(started) : now;
}

export function isActiveImageJobStatus(status: ImageJobStatus): boolean {
  return status === "queued" || status === "running" || status === "stopping";
}

/**
 * Startup/recovery-only reconciliation. It must not run while a live job may
 * have an in-flight attempt, because unmatched started attempts are marked
 * interrupted once scanning finishes. Calls are serialized inside one process;
 * a persisted active job is refused unless the caller explicitly passes
 * allowActiveJob after proving no live owner remains.
 */
export function reconcileImages(
  storage: Storage,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  return withImageManifestLock(storage, () =>
    reconcileImagesUnlocked(storage, options),
  );
}

async function reconcileImagesUnlocked(
  storage: Storage,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const job = await loadImageJob(storage);
  if (
    !options.allowActiveJob &&
    job !== undefined &&
    isActiveImageJobStatus(job.status)
  ) {
    throw new ImageStateError(
      "Refusing to reconcile while image-job.json reports an active job. Mark it interrupted first or pass allowActiveJob after proving no owner is live.",
    );
  }

  const now = options.now ?? new Date();
  let manifest = await loadImageManifest(storage);
  let changed = false;
  const reconciled: ReconcileResult["reconciled"][number][] = [];
  const quarantined: ReconcileResult["quarantined"][number][] = [];
  const interruptedAttempts: ReconcileResult["interruptedAttempts"][number][] = [];

  const referenced = referencedFilenames(manifest);
  const files = await listImageFiles(storage);

  for (const file of files) {
    if (referenced.has(file.name)) continue;
    const parsed = parseImageFilename(file.name);
    if (!parsed) {
      const moved = await quarantineFile(storage, file.name);
      quarantined.push({
        filename: file.name,
        reason: "unrecognized image filename",
        movedTo: moved.movedTo,
        error: moved.error,
      });
      continue;
    }

    const state = manifest.products[parsed.productId];
    const attempt = state?.attempts.find(
      (candidate) => candidate.attemptId === parsed.attemptId,
    );
    if (!attempt || attempt.status !== "started") {
      const moved = await quarantineFile(storage, file.name);
      quarantined.push({
        filename: file.name,
        reason: "no matching started attempt",
        movedTo: moved.movedTo,
        error: moved.error,
      });
      continue;
    }

    if (file.mtimeMs < Date.parse(attempt.startedAt)) {
      const moved = await quarantineFile(storage, file.name);
      quarantined.push({
        filename: file.name,
        reason: "file modification time precedes the attempt start",
        movedTo: moved.movedTo,
        error: moved.error,
      });
      continue;
    }

    let bytes: Buffer | undefined;
    try {
      bytes = await storage.readFile(["images", file.name]);
    } catch (error) {
      const moved = await quarantineFile(storage, file.name);
      quarantined.push({
        filename: file.name,
        reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
        movedTo: moved.movedTo,
        error: moved.error,
      });
      continue;
    }
    if (bytes === undefined) {
      quarantined.push({
        filename: file.name,
        reason: "file disappeared during reconciliation",
        movedTo: null,
        error: null,
      });
      continue;
    }

    try {
      const validation = validateImageBytes(bytes, { filename: file.name });
      const finishedAt = finishTimeAtOrAfter(attempt.startedAt, now);
      manifest = publishAttempt(manifest, parsed.productId, parsed.attemptId, {
        filename: file.name,
        validation,
        publishedAt: finishedAt,
        finishedAt,
      });
      changed = true;
      reconciled.push({
        productId: parsed.productId,
        attemptId: parsed.attemptId,
        filename: file.name,
      });
    } catch (error) {
      manifest = markAttemptFailed(
        manifest,
        parsed.productId,
        parsed.attemptId,
        {
          finishedAt: finishTimeAtOrAfter(attempt.startedAt, now),
          error: `Reconciled file was rejected: ${error instanceof Error ? error.message : String(error)}`,
        },
      );
      changed = true;
      const moved = await quarantineFile(storage, file.name);
      quarantined.push({
        filename: file.name,
        reason: `invalid image: ${error instanceof Error ? error.message : String(error)}`,
        movedTo: moved.movedTo,
        error: moved.error,
      });
    }
  }

  for (const productId of PRODUCT_IDS) {
    const state = manifest.products[productId];
    if (!state) continue;
    for (const attempt of [...state.attempts]) {
      if (attempt.status !== "started") continue;
      manifest = markAttemptInterrupted(manifest, productId, attempt.attemptId, {
        finishedAt: finishTimeAtOrAfter(attempt.startedAt, now),
        error: "Interrupted: no matching image file was found during reconciliation.",
      });
      changed = true;
      interruptedAttempts.push({
        productId,
        attemptId: attempt.attemptId,
      });
    }
  }

  if (changed) {
    await saveImageManifest(storage, manifest);
  }

  return {
    manifest,
    activeImages: await inspectActiveImages(storage, manifest),
    reconciled,
    quarantined,
    interruptedAttempts,
  };
}

function readUsdAmount(value: unknown, label: string): string {
  if (typeof value !== "string") corrupted(`${label} must be a decimal USD string.`);
  try {
    parseUsdToMicro(value);
  } catch {
    corrupted(`${label} must be a decimal USD string.`);
  }
  return value;
}

function parseImageJobQuote(value: unknown): ImageJobQuote {
  if (!isRecord(value)) corrupted("job.quote must be an object.");
  if (typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)) {
    corrupted("job.quote.fingerprint must be a SHA-256 hex digest.");
  }
  const selection = imageModelSettingsSchema.safeParse(value.selection);
  if (!selection.success) corrupted("job.quote.selection is invalid.");
  if (
    !Array.isArray(value.providerOnly) ||
    value.providerOnly.length > 5 ||
    value.providerOnly.some(
      (provider) => typeof provider !== "string" || provider.length === 0 || provider.length > 64,
    )
  ) {
    corrupted("job.quote.providerOnly is invalid.");
  }
  if (value.attemptsPerImage !== QUOTE_ATTEMPTS_PER_IMAGE) {
    corrupted(
      `job.quote.attemptsPerImage must be ${QUOTE_ATTEMPTS_PER_IMAGE}.`,
    );
  }
  return {
    fingerprint: value.fingerprint,
    selection: selection.data,
    providerSlug: readString(value.providerSlug, "job.quote.providerSlug", 64),
    providerTag: readNullableString(
      value.providerTag,
      "job.quote.providerTag",
      64,
    ),
    providerOnly: value.providerOnly,
    unitPriceUsd: readUsdAmount(value.unitPriceUsd, "job.quote.unitPriceUsd"),
    baseUsd: readUsdAmount(value.baseUsd, "job.quote.baseUsd"),
    worstCaseUsd: readUsdAmount(value.worstCaseUsd, "job.quote.worstCaseUsd"),
    startingBalanceBaseUsd: readUsdAmount(
      value.startingBalanceBaseUsd,
      "job.quote.startingBalanceBaseUsd",
    ),
    startingBalanceWorstCaseUsd: readUsdAmount(
      value.startingBalanceWorstCaseUsd,
      "job.quote.startingBalanceWorstCaseUsd",
    ),
    perRequestFloorUsd: readUsdAmount(
      value.perRequestFloorUsd,
      "job.quote.perRequestFloorUsd",
    ),
    attemptsPerImage: QUOTE_ATTEMPTS_PER_IMAGE,
    imageCount: readInteger(value.imageCount, "job.quote.imageCount", 1, 24),
  };
}

export function parseImageJobSnapshot(value: unknown): ImageJobSnapshot {
  if (!isRecord(value)) corrupted("job snapshot must be an object.");
  if (value.version !== IMAGE_JOB_VERSION) {
    corrupted(`unsupported job version ${String(value.version)}.`);
  }
  if (!isUuid(value.jobId)) corrupted("job.jobId must be a UUID.");
  const status = value.status;
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "stopping" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "interrupted" &&
    status !== "stopped_by_user"
  ) {
    corrupted("job.status is invalid.");
  }
  const createdAt = readIsoTimestamp(value.createdAt, "job.createdAt");
  const updatedAt = readIsoTimestamp(value.updatedAt, "job.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    corrupted("job.updatedAt cannot precede job.createdAt.");
  }

  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    corrupted("job.targets must be a non-empty array.");
  }
  const targets: ImageJobTarget[] = [];
  const productIds = new Set<string>();
  for (const raw of value.targets) {
    if (!isRecord(raw)) corrupted("job target must be an object.");
    const productId = raw.productId;
    if (!isProductId(productId)) corrupted("job target productId is invalid.");
    if (productIds.has(productId)) {
      corrupted(`duplicate job target ${productId}.`);
    }
    productIds.add(productId);
    const targetStatus = raw.status;
    if (
      targetStatus !== "queued" &&
      targetStatus !== "generating" &&
      targetStatus !== "succeeded" &&
      targetStatus !== "failed" &&
      targetStatus !== "reused"
    ) {
      corrupted("job target status is invalid.");
    }
    const attemptId = raw.attemptId;
    if (attemptId !== null && !isUuid(attemptId)) {
      corrupted("job target attemptId must be a UUID or null.");
    }
    if (targetStatus === "queued" && attemptId !== null) {
      corrupted("queued job targets cannot have an attempt ID.");
    }
    if (targetStatus === "succeeded" && attemptId === null) {
      corrupted("succeeded job targets require an attempt ID.");
    }
    if (targetStatus === "reused" && attemptId !== null) {
      corrupted("reused job targets cannot have a new attempt ID.");
    }
    const error = readNullableString(raw.error, "job target error", 2000);
    targets.push({ productId, status: targetStatus, attemptId, error });
  }
  if (status === "queued" && targets.some((target) => target.status !== "queued")) {
    corrupted("queued jobs require all targets to be queued.");
  }
  if (
    status === "completed" &&
    targets.some(
      (target) =>
        target.status !== "succeeded" && target.status !== "reused",
    )
  ) {
    corrupted("completed jobs require every target to be succeeded or reused.");
  }

  let stopRequest: ImageJobStopRequest | null = null;
  if (value.stopRequest !== null && value.stopRequest !== undefined) {
    if (!isRecord(value.stopRequest)) {
      corrupted("job.stopRequest must be an object or null.");
    }
    const stopJobId = value.stopRequest.jobId;
    if (!isUuid(stopJobId) || stopJobId !== value.jobId) {
      corrupted("job.stopRequest.jobId must match the job ID.");
    }
    stopRequest = {
      jobId: stopJobId,
      requestedAt: readIsoTimestamp(
        value.stopRequest.requestedAt,
        "job.stopRequest.requestedAt",
      ),
    };
  }

  if (
    (status === "stopping" || status === "stopped_by_user") &&
    stopRequest === null
  ) {
    corrupted(`${status} jobs require a persisted stop request.`);
  }

  const error = readNullableString(value.error, "job.error", 2000);
  let quote: ImageJobQuote | null = null;
  if (value.quote !== undefined && value.quote !== null) {
    quote = parseImageJobQuote(value.quote);
    if (quote.imageCount !== targets.length) {
      corrupted("job.quote.imageCount must match the number of targets.");
    }
  }

  return {
    version: IMAGE_JOB_VERSION,
    jobId: value.jobId,
    status,
    createdAt,
    updatedAt,
    targets,
    stopRequest,
    quote,
    error,
  };
}

export function createImageJobSnapshot(options: {
  readonly jobId: string;
  readonly productIds: readonly ProductId[];
  readonly now?: Date | undefined;
}): ImageJobSnapshot {
  if (!isUuid(options.jobId)) {
    throw new ImageStateError(`Invalid job ID: ${String(options.jobId)}.`);
  }
  if (options.productIds.length === 0) {
    throw new ImageStateError("A job must have at least one target.");
  }
  const seen = new Set<string>();
  for (const productId of options.productIds) {
    if (!PRODUCT_ID_SET.has(productId)) {
      throw new ImageStateError(`Unknown product ID: ${String(productId)}.`);
    }
    if (seen.has(productId)) {
      throw new ImageStateError(`Duplicate job target: ${productId}.`);
    }
    seen.add(productId);
  }
  const timestamp = (options.now ?? new Date()).toISOString();
  return {
    version: IMAGE_JOB_VERSION,
    jobId: options.jobId,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    targets: options.productIds.map((productId) => ({
      productId,
      status: "queued",
      attemptId: null,
      error: null,
    })),
    stopRequest: null,
    quote: null,
    error: null,
  };
}

export async function loadImageJob(
  storage: Storage,
): Promise<ImageJobSnapshot | undefined> {
  let raw: unknown;
  try {
    raw = await storage.readJson<unknown>(JOB_SEGMENTS);
  } catch (error) {
    if (error instanceof StorageCorruptionError) {
      throw new ImageStateCorruptionError(
        "The image job snapshot contains malformed JSON. Inspect it manually; no data was changed.",
        { cause: error },
      );
    }
    throw error;
  }
  if (raw === undefined) return undefined;
  return parseImageJobSnapshot(raw);
}

export async function saveImageJob(
  storage: Storage,
  job: ImageJobSnapshot,
): Promise<void> {
  const normalized = parseImageJobSnapshot(job);
  await storage.writeJson(JOB_SEGMENTS, normalized);
}

export function effectiveJobStatus(
  job: ImageJobSnapshot | undefined,
  isLive: boolean,
): ImageJobStatus | null {
  if (!job) return null;
  if (
    !isLive &&
    (job.status === "queued" ||
      job.status === "running" ||
      job.status === "stopping")
  ) {
    return "interrupted";
  }
  return job.status;
}

export function deriveSetupState(
  input: DeriveSetupStateInput,
): SetupState {
  const validSet = new Set<string>();
  for (const productId of input.validImageIds) {
    if (PRODUCT_ID_SET.has(productId)) validSet.add(productId);
  }
  const validImageIds = PRODUCT_IDS.filter((productId) =>
    validSet.has(productId),
  );
  const validImageCount = validImageIds.length;
  const missingImageIds = PRODUCT_IDS.filter(
    (productId) => !validSet.has(productId),
  );

  const invalidActiveImageIds = PRODUCT_IDS.filter((productId) => {
    const active = input.manifest.products[productId]?.active ?? null;
    return active !== null && !validSet.has(productId);
  });

  const job = input.job;
  const jobIsLive = input.jobIsLive ?? false;
  const status = effectiveJobStatus(job, jobIsLive);
  const live =
    jobIsLive &&
    (job?.status === "queued" ||
      job?.status === "running" ||
      job?.status === "stopping");

  const hasProblemAttempt = PRODUCT_IDS.some((productId) =>
    (input.manifest.products[productId]?.attempts ?? []).some(
      (attempt) =>
        attempt.status === "started" ||
        attempt.status === "failed" ||
        attempt.status === "interrupted",
    ),
  );
  const hasUnpublishedSuccess = PRODUCT_IDS.some((productId) => {
    const state = input.manifest.products[productId];
    return (
      state !== undefined &&
      state.active === null &&
      state.attempts.some((attempt) => attempt.status === "succeeded")
    );
  });
  const hasProblemJob =
    status === "failed" ||
    status === "interrupted" ||
    status === "stopped_by_user";
  const failedRegeneration =
    validImageCount === PRODUCT_IDS.length &&
    (status === "failed" ||
      status === "interrupted" ||
      status === "stopped_by_user");

  let setupStatus: SetupStatus;
  if (live && job?.status === "stopping") {
    setupStatus = "stopping";
  } else if (live) {
    setupStatus = "generating";
  } else if (validImageCount === PRODUCT_IDS.length) {
    setupStatus = "completed";
  } else if (
    (validImageCount > 0 && validImageCount < PRODUCT_IDS.length) ||
    invalidActiveImageIds.length > 0 ||
    hasUnpublishedSuccess ||
    hasProblemAttempt ||
    hasProblemJob
  ) {
    setupStatus = "incomplete";
  } else if (!input.keyAvailable) {
    setupStatus = "not_configured";
  } else {
    setupStatus = "ready_to_generate";
  }

  return {
    status: setupStatus,
    keyAvailable: input.keyAvailable,
    validImageIds,
    missingImageIds,
    invalidActiveImageIds,
    validImageCount,
    totalImageCount: PRODUCT_IDS.length,
    job: {
      jobId: job?.jobId ?? null,
      status,
      isLive: live,
      failedRegeneration,
    },
  };
}

export interface InspectSetupStateOptions {
  readonly keyAvailable: boolean;
  readonly jobIsLive?: boolean | undefined;
}

export async function inspectSetupState(
  storage: Storage,
  options: InspectSetupStateOptions,
): Promise<SetupState> {
  const manifest = await loadImageManifest(storage);
  const inspections = await inspectActiveImages(storage, manifest);
  const validImageIds = inspections
    .filter((inspection) => inspection.valid)
    .map((inspection) => inspection.productId);
  const job = await loadImageJob(storage);
  return deriveSetupState({
    keyAvailable: options.keyAvailable,
    manifest,
    validImageIds,
    job,
    jobIsLive: options.jobIsLive,
  });
}

/**
 * Exact micro-USD view of an attempt cost for totals; null for unknown or
 * values that cannot be represented at six decimals. Never sum `cost.usd`
 * floats directly.
 */
export function imageCostToMicro(cost: ImageCost): bigint | null {
  if (cost.kind === "unknown") return null;
  if (!Number.isFinite(cost.usd) || cost.usd < 0) return null;
  const micro = BigInt(Math.round(cost.usd * 1_000_000));
  if (Number(formatUsdMicro(micro)) !== cost.usd) return null;
  return micro;
}

export function attemptFilename(
  productId: ProductId,
  attemptId: string,
  format: ImageFormat,
): string {
  return buildAttemptFilename(productId, attemptId, format);
}

export function attemptExtension(format: ImageFormat): "png" | "jpg" | "webp" {
  return extensionForFormat(format);
}
