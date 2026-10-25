import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ProductId } from "../lib/products";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MIN_IMAGE_DIMENSION = 1;
export const MAX_IMAGE_DIMENSION = 8192;

export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

export type ImageValidationCode =
  | "empty"
  | "too-large"
  | "unsupported-format"
  | "corrupt"
  | "unsupported-dimensions"
  | "filename-mismatch";

export class ImageValidationError extends Error {
  readonly code: ImageValidationCode;

  constructor(code: ImageValidationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageValidationError";
    this.code = code;
  }
}

export interface ValidatedImage {
  readonly format: ImageFormat;
  readonly mediaType: string;
  readonly extension: "png" | "jpg" | "webp";
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ParsedImageFilename {
  readonly productId: ProductId;
  readonly attemptId: string;
  readonly format: ImageFormat;
  readonly extension: "png" | "jpg" | "webp";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRODUCT_ID_PATTERN = /^P(?:0[1-9]|1[0-9]|2[0-4])$/;
const FILENAME_PATTERN =
  /^(P(?:0[1-9]|1[0-9]|2[0-4]))-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpe?g|webp)$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isProductId(value: unknown): value is ProductId {
  return typeof value === "string" && PRODUCT_ID_PATTERN.test(value);
}

export function mediaTypeForFormat(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}

export function extensionForFormat(format: ImageFormat): "png" | "jpg" | "webp" {
  return format === "jpeg" ? "jpg" : format;
}

export function formatForExtension(extension: string): ImageFormat | undefined {
  const normalized = extension.toLowerCase();
  if (normalized === "png") return "png";
  if (normalized === "jpg" || normalized === "jpeg") return "jpeg";
  if (normalized === "webp") return "webp";
  return undefined;
}

export function buildAttemptFilename(
  productId: ProductId,
  attemptId: string,
  format: ImageFormat,
): string {
  if (!PRODUCT_ID_PATTERN.test(productId)) {
    throw new ImageValidationError(
      "filename-mismatch",
      `Invalid product ID for an image filename: ${JSON.stringify(productId)}.`,
    );
  }
  if (!UUID_PATTERN.test(attemptId)) {
    throw new ImageValidationError(
      "filename-mismatch",
      `Invalid attempt ID for an image filename: ${JSON.stringify(attemptId)}.`,
    );
  }
  return `${productId}-${attemptId}.${extensionForFormat(format)}`;
}

export function parseImageFilename(
  filename: string,
): ParsedImageFilename | undefined {
  if (typeof filename !== "string" || filename.length > 200) return undefined;
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) return undefined;
  const productId = match[1];
  const attemptId = match[2];
  const extension = match[3];
  if (!productId || !attemptId || !extension) return undefined;
  if (!isProductId(productId)) return undefined;
  const format = formatForExtension(extension);
  if (!format) return undefined;
  return {
    productId,
    attemptId: attemptId.toLowerCase(),
    format,
    extension: extensionForFormat(format),
  };
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10000
  );
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)
  );
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10000 +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 0x100 + (bytes[offset + 1] ?? 0);
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 0x100;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function corrupt(message: string): never {
  throw new ImageValidationError("corrupt", message);
}

function parsePng(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 45) corrupt("PNG data is too short.");
  if (!signature.every((value, index) => bytes[index] === value)) {
    corrupt("Invalid PNG signature.");
  }
  if (readUInt32BE(bytes, 8) !== 13 || ascii(bytes, 12, 16) !== "IHDR") {
    corrupt("PNG is missing its IHDR chunk.");
  }
  const width = readUInt32BE(bytes, 16);
  const height = readUInt32BE(bytes, 20);
  if (width === 0 || height === 0) corrupt("PNG has zero dimensions.");

  let offset = 8;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const length = readUInt32BE(bytes, offset);
    if (offset + 12 + length > bytes.length) {
      corrupt("PNG contains a truncated chunk.");
    }
    const type = ascii(bytes, offset + 4, offset + 8);
    if (type === "IDAT" && length > 0) sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || offset + 12 !== bytes.length) {
        corrupt("PNG IEND chunk is invalid or has trailing bytes.");
      }
      sawIend = true;
      break;
    }
    offset += 12 + length;
  }
  if (!sawIdat) corrupt("PNG has no IDAT image data.");
  if (!sawIend) corrupt("PNG is missing its IEND chunk.");
  return { width, height };
}

function isJpegSofMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4) corrupt("JPEG data is too short.");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) corrupt("Invalid JPEG SOI marker.");
  if (
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    corrupt("JPEG is missing its EOI marker.");
  }

  let offset = 2;
  let dimensions: { width: number; height: number } | undefined;
  let sawScan = false;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) corrupt("Invalid JPEG marker prefix.");
    let markerOffset = offset + 1;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    const marker = bytes[markerOffset];
    if (marker === undefined) corrupt("Truncated JPEG marker.");
    offset = markerOffset + 1;

    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda) {
      if (offset + 2 > bytes.length - 2) {
        corrupt("JPEG scan header is truncated.");
      }
      const length = readUInt16BE(bytes, offset);
      const scanStart = offset + length;
      if (length < 2 || scanStart >= bytes.length - 2) {
        corrupt("JPEG scan has no entropy-coded image data.");
      }
      sawScan = true;
      break;
    }

    if (offset + 2 > bytes.length) corrupt("Truncated JPEG segment length.");
    const length = readUInt16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) {
      corrupt("Invalid JPEG segment length.");
    }
    if (isJpegSofMarker(marker)) {
      if (length < 7) corrupt("JPEG SOF segment is too short.");
      const height = readUInt16BE(bytes, offset + 3);
      const width = readUInt16BE(bytes, offset + 5);
      dimensions = { width, height };
    }
    offset += length;
  }

  if (!sawScan) corrupt("JPEG is missing an image scan.");
  if (!dimensions) corrupt("JPEG is missing a supported SOF segment.");
  if (dimensions.width === 0 || dimensions.height === 0) {
    corrupt("JPEG has zero dimensions.");
  }
  return dimensions;
}

function parseWebp(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 21) corrupt("WebP data is too short.");
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") {
    corrupt("Invalid WebP RIFF header.");
  }
  const riffSize = readUInt32LE(bytes, 4);
  if (riffSize + 8 !== bytes.length) {
    corrupt("Invalid WebP RIFF size.");
  }

  const chunks: Array<{
    readonly type: string;
    readonly offset: number;
    readonly size: number;
  }> = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4);
    const size = readUInt32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > bytes.length) {
      corrupt("Invalid WebP chunk size.");
    }
    chunks.push({ type, offset: dataOffset, size });
    offset = dataOffset + size + (size % 2);
  }
  if (offset !== bytes.length) corrupt("WebP has trailing or truncated chunk data.");

  const first = chunks[0];
  if (!first) corrupt("WebP has no chunks.");
  const chunkType = first.type;
  const chunkSize = first.size;
  const dataOffset = first.offset;
  if (chunkSize < 1) corrupt("Invalid WebP chunk size.");

  const hasImagePayload = chunks.some(
    (chunk) =>
      chunk.size > 0 &&
      (chunk.type === "VP8 " || chunk.type === "VP8L" || chunk.type === "ANMF"),
  );

  if (chunkType === "VP8X") {
    if (chunkSize < 10) corrupt("WebP VP8X chunk is too short.");
    if (!hasImagePayload) {
      corrupt("WebP VP8X container has no image payload.");
    }
    return {
      width: 1 + readUInt24LE(bytes, dataOffset + 4),
      height: 1 + readUInt24LE(bytes, dataOffset + 7),
    };
  }
  if (chunkType === "VP8L") {
    if (chunkSize < 5 || bytes[dataOffset] !== 0x2f) {
      corrupt("Invalid WebP VP8L header.");
    }
    const bits = readUInt32LE(bytes, dataOffset + 1);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunkType === "VP8 ") {
    if (
      chunkSize < 10 ||
      bytes[dataOffset + 3] !== 0x9d ||
      bytes[dataOffset + 4] !== 0x01 ||
      bytes[dataOffset + 5] !== 0x2a
    ) {
      corrupt("Invalid WebP VP8 header.");
    }
    return {
      width: readUInt16LE(bytes, dataOffset + 6) & 0x3fff,
      height: readUInt16LE(bytes, dataOffset + 8) & 0x3fff,
    };
  }

  corrupt(`Unsupported WebP chunk type: ${JSON.stringify(chunkType)}.`);
}

function detectFormat(bytes: Uint8Array): ImageFormat {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "jpeg";
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "RIFF") {
    return "webp";
  }
  throw new ImageValidationError(
    "unsupported-format",
    "Unsupported image format. Only PNG, JPEG, and WebP are accepted; SVG is rejected.",
  );
}

const DECODE_CACHE_LIMIT = 64;
const decodeCache = new Map<
  string,
  { readonly format: ImageFormat; readonly width: number; readonly height: number }
>();

/**
 * A header is not an image. Force a bounded libvips decode of the actual
 * pixel payload and use the decoded metadata as the authority; structural
 * parsing above only rejects malformed containers early.
 */
async function decodeDimensions(
  bytes: Uint8Array,
  format: ImageFormat,
): Promise<{ readonly width: number; readonly height: number }> {
  try {
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (metadata.format !== format) {
      corrupt(
        `Image bytes are ${metadata.format ?? "an unknown format"}, not ${format}.`,
      );
    }
    const width = metadata.width;
    const height = metadata.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1
    ) {
      corrupt("The image decoder did not report usable dimensions.");
    }
    // Decode into a single bounded pixel so a compressed bomb cannot allocate
    // the full image while still proving that the payload is decodable.
    await image.resize(1, 1, { fit: "inside" }).raw().toBuffer();
    return { width, height };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    corrupt(
      `The image payload could not be decoded (${
        error instanceof Error ? error.message : "unknown decoder error"
      }).`,
    );
  }
}

export async function validateImageBytes(
  bytes: Uint8Array,
  options: { readonly filename?: string | undefined } = {},
): Promise<ValidatedImage> {
  if (bytes.byteLength === 0) {
    throw new ImageValidationError("empty", "Image data is empty.");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageValidationError(
      "too-large",
      `Image data exceeds the ${MAX_IMAGE_BYTES}-byte limit.`,
    );
  }

  const format = detectFormat(bytes);
  const dimensions =
    format === "png"
      ? parsePng(bytes)
      : format === "jpeg"
        ? parseJpeg(bytes)
        : parseWebp(bytes);

  if (
    dimensions.width < MIN_IMAGE_DIMENSION ||
    dimensions.height < MIN_IMAGE_DIMENSION ||
    dimensions.width > MAX_IMAGE_DIMENSION ||
    dimensions.height > MAX_IMAGE_DIMENSION
  ) {
    throw new ImageValidationError(
      "unsupported-dimensions",
      `Image dimensions ${dimensions.width}x${dimensions.height} are outside the supported ${MIN_IMAGE_DIMENSION}-${MAX_IMAGE_DIMENSION} range.`,
    );
  }

  if (options.filename !== undefined) {
    const parsed = parseImageFilename(options.filename);
    if (!parsed || parsed.format !== format) {
      throw new ImageValidationError(
        "filename-mismatch",
        `Image bytes do not match the filename ${JSON.stringify(options.filename)}.`,
      );
    }
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let decoded = decodeCache.get(sha256);
  if (!decoded || decoded.format !== format) {
    const result = await decodeDimensions(bytes, format);
    decoded = { format, width: result.width, height: result.height };
    if (decodeCache.size >= DECODE_CACHE_LIMIT) {
      const oldest = decodeCache.keys().next().value;
      if (oldest !== undefined) decodeCache.delete(oldest);
    }
    decodeCache.set(sha256, decoded);
  }
  if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) {
    corrupt(
      `The image decoder reported ${decoded.width}x${decoded.height}, but the container declared ${dimensions.width}x${dimensions.height}.`,
    );
  }

  return {
    format,
    mediaType: mediaTypeForFormat(format),
    extension: extensionForFormat(format),
    width: dimensions.width,
    height: dimensions.height,
    sizeBytes: bytes.byteLength,
    sha256,
  };
}
