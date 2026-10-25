import { describe, expect, it } from "vitest";
import {
  buildAttemptFilename,
  ImageValidationError,
  MAX_IMAGE_BYTES,
  parseImageFilename,
  validateImageBytes,
} from "../src/server/image-validation";
import {
  attemptId,
  jpegBytes,
  pngBytes,
  svgBytes,
  webpVp8Bytes,
  webpVp8lBytes,
  webpVp8xBytes,
} from "./helpers/image-fixtures";

function headerOnlyPng(): Buffer {
  const buffer = Buffer.alloc(8 + 25 + 12);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(32, 16);
  buffer.writeUInt32BE(32, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  buffer.writeUInt32BE(0, 33);
  buffer.write("IEND", 37, "ascii");
  return buffer;
}

function headerOnlyJpeg(): Buffer {
  const payload = Buffer.alloc(15);
  payload[0] = 8;
  payload.writeUInt16BE(32, 1);
  payload.writeUInt16BE(32, 3);
  payload[5] = 3;
  payload.set([0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 6);
  const buffer = Buffer.alloc(2 + 2 + 2 + payload.length + 2);
  buffer.set([0xff, 0xd8, 0xff, 0xc0], 0);
  buffer.writeUInt16BE(payload.length + 2, 4);
  payload.copy(buffer, 6);
  buffer.set([0xff, 0xd9], 6 + payload.length);
  return buffer;
}

function headerOnlyWebp(): Buffer {
  const payload = Buffer.alloc(10);
  payload[4] = 31;
  payload[5] = 0;
  payload[6] = 0;
  payload[7] = 31;
  payload[8] = 0;
  payload[9] = 0;
  const buffer = Buffer.alloc(20 + payload.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(4 + 4 + 4 + payload.length, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

describe("image byte validation", () => {
  it("validates PNG, JPEG, and WebP bytes and reports verified metadata", async () => {
    const png = await validateImageBytes(pngBytes(48, 32));
    expect(png).toMatchObject({
      format: "png",
      mediaType: "image/png",
      extension: "png",
      width: 48,
      height: 32,
      sizeBytes: pngBytes(48, 32).length,
    });
    expect(png.sha256).toMatch(/^[0-9a-f]{64}$/);

    const jpeg = await validateImageBytes(await jpegBytes(40, 30));
    expect(jpeg).toMatchObject({
      format: "jpeg",
      mediaType: "image/jpeg",
      extension: "jpg",
      width: 40,
      height: 30,
    });

    for (const bytes of [
      await webpVp8lBytes(33, 17),
      await webpVp8xBytes(34, 18),
      await webpVp8Bytes(35, 19),
    ]) {
      expect(await validateImageBytes(bytes)).toMatchObject({
        format: "webp",
        mediaType: "image/webp",
        extension: "webp",
      });
    }
  });

  it("rejects header-only containers with no decodable image payload", async () => {
    for (const bytes of [headerOnlyPng(), headerOnlyJpeg(), headerOnlyWebp()]) {
      await expect(validateImageBytes(bytes)).rejects.toMatchObject({
        code: "corrupt",
      });
    }
  });

  it("rejects SVG, empty, oversized, malformed, and implausible images", async () => {
    await expect(validateImageBytes(svgBytes)).rejects.toMatchObject({
      code: "unsupported-format",
    });
    await expect(validateImageBytes(Buffer.alloc(0))).rejects.toMatchObject({
      code: "empty",
    });
    await expect(
      validateImageBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1)),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(
      validateImageBytes(Buffer.from("not an image")),
    ).rejects.toBeInstanceOf(ImageValidationError);
    await expect(validateImageBytes(pngBytes(9000, 16))).rejects.toMatchObject({
      code: "unsupported-dimensions",
    });

    const truncatedPng = pngBytes().subarray(0, 20);
    await expect(validateImageBytes(truncatedPng)).rejects.toMatchObject({
      code: "corrupt",
    });
    const truncatedJpeg = (await jpegBytes()).subarray(0, 12);
    await expect(validateImageBytes(truncatedJpeg)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("requires the filename to match the verified bytes", async () => {
    const id = attemptId(1);
    expect(
      (
        await validateImageBytes(pngBytes(), {
          filename: buildAttemptFilename("P01", id, "png"),
        })
      ).format,
    ).toBe("png");
    await expect(
      validateImageBytes(await jpegBytes(), {
        filename: buildAttemptFilename("P01", id, "png"),
      }),
    ).rejects.toMatchObject({ code: "filename-mismatch" });
  });

  it("rejects truncated WebP and trailing bytes after the declared payload", async () => {
    await expect(
      validateImageBytes((await webpVp8lBytes()).subarray(0, 10)),
    ).rejects.toMatchObject({ code: "corrupt" });
    await expect(
      validateImageBytes(
        Buffer.concat([await webpVp8lBytes(), Buffer.from([0])]),
      ),
    ).rejects.toMatchObject({ code: "corrupt" });
    await expect(
      validateImageBytes(Buffer.concat([pngBytes(), Buffer.from("IEND")])),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("builds and parses only canonical product/attempt filenames", async () => {
    const id = attemptId(2);
    expect(buildAttemptFilename("P24", id, "jpeg")).toBe(`P24-${id}.jpg`);
    expect(parseImageFilename(`P24-${id}.jpg`)).toEqual({
      productId: "P24",
      attemptId: id,
      format: "jpeg",
      extension: "jpg",
    });
    expect(parseImageFilename(`P24-${id}.jpeg`)).toMatchObject({
      format: "jpeg",
      extension: "jpg",
    });
    expect(parseImageFilename("../P01-image.png")).toBeUndefined();
    expect(parseImageFilename(`P00-${id}.png`)).toBeUndefined();
    expect(parseImageFilename(`P01-${id}.svg`)).toBeUndefined();
    expect(parseImageFilename(`P25-${id}.png`)).toBeUndefined();
    expect(parseImageFilename(`p01-${id}.png`)).toBeUndefined();
    expect(parseImageFilename(`P01-${id.toUpperCase()}.PNG`)).toMatchObject({
      productId: "P01",
      attemptId: id,
      format: "png",
    });
    expect(
      (
        await validateImageBytes(pngBytes(), {
          filename: `P01-${id.toUpperCase()}.PNG`,
        })
      ).format,
    ).toBe("png");
    expect(() => buildAttemptFilename("P01", "not-a-uuid", "png")).toThrow(
      ImageValidationError,
    );
  });
});
