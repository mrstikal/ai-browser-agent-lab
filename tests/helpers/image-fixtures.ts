import { deflateSync } from "node:zlib";
import sharp from "sharp";

export function attemptId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/**
 * Real, decodable RGBA PNG. Image validation now forces a bounded decode, so
 * header-only fixtures are no longer accepted.
 */
export function pngBytes(width = 32, height = 32): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = (x * 17) & 0xff;
    row[2 + x * 4] = 0x40;
    row[3 + x * 4] = 0x80;
    row[4 + x * 4] = 0xff;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function sharpImage(
  width: number,
  height: number,
  format: "jpeg" | "webp",
  options: { lossless?: boolean; alphaQuality?: number; alpha?: boolean } = {},
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: options.alpha === true ? 4 : 3,
      background: { r: 0x20, g: 0x80, b: 0xc0, alpha: 1 },
    },
  });
  return format === "jpeg"
    ? image.jpeg({ quality: 80 }).toBuffer()
    : image
        .webp({
          lossless: options.lossless,
          alphaQuality: options.alphaQuality,
        })
        .toBuffer();
}

export async function jpegBytes(width = 32, height = 32): Promise<Buffer> {
  return sharpImage(width, height, "jpeg");
}

export async function webpVp8lBytes(width = 32, height = 32): Promise<Buffer> {
  return sharpImage(width, height, "webp", { lossless: true });
}

export async function webpVp8xBytes(width = 32, height = 32): Promise<Buffer> {
  return sharpImage(width, height, "webp", {
    lossless: false,
    alphaQuality: 80,
    alpha: true,
  });
}

export async function webpVp8Bytes(width = 32, height = 32): Promise<Buffer> {
  return sharpImage(width, height, "webp", { lossless: false });
}

export const svgBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>',
  "utf8",
);

/**
 * Timestamp for jobs/attempts assembled by tests. The WSL host clock steps
 * backwards by ~1 s every ~15-30 s, which would make a hand-written
 * `new Date()` violate the persisted monotonicity checks; this returns the
 * newest of the given stored stamps and the wall clock.
 */
export function monotonicStamp(
  ...stored: Array<string | null | undefined>
): string {
  let stamp = Date.now();
  for (const value of stored) {
    if (value === null || value === undefined) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > stamp) stamp = parsed;
  }
  return new Date(stamp).toISOString();
}
