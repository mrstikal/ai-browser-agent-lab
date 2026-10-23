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

describe("image byte validation", () => {
  it("validates PNG, JPEG, and WebP bytes and reports verified metadata", () => {
    const png = validateImageBytes(pngBytes(48, 32));
    expect(png).toMatchObject({
      format: "png",
      mediaType: "image/png",
      extension: "png",
      width: 48,
      height: 32,
      sizeBytes: 45,
    });
    expect(png.sha256).toMatch(/^[0-9a-f]{64}$/);

    const jpeg = validateImageBytes(jpegBytes(40, 30));
    expect(jpeg).toMatchObject({
      format: "jpeg",
      mediaType: "image/jpeg",
      extension: "jpg",
      width: 40,
      height: 30,
    });

    for (const bytes of [
      webpVp8lBytes(33, 17),
      webpVp8xBytes(34, 18),
      webpVp8Bytes(35, 19),
    ]) {
      expect(validateImageBytes(bytes)).toMatchObject({
        format: "webp",
        mediaType: "image/webp",
        extension: "webp",
      });
    }
  });

  it("rejects SVG, empty, oversized, malformed, and implausible images", () => {
    expect(() => validateImageBytes(svgBytes)).toThrow(
      expect.objectContaining({ code: "unsupported-format" }),
    );
    expect(() => validateImageBytes(Buffer.alloc(0))).toThrow(
      expect.objectContaining({ code: "empty" }),
    );
    expect(() => validateImageBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "too-large" }),
    );
    expect(() => validateImageBytes(Buffer.from("not an image"))).toThrow(
      ImageValidationError,
    );
    expect(() =>
      validateImageBytes(pngBytes(9000, 16)),
    ).toThrow(expect.objectContaining({ code: "unsupported-dimensions" }));

    const truncatedPng = pngBytes().subarray(0, 20);
    expect(() => validateImageBytes(truncatedPng)).toThrow(
      expect.objectContaining({ code: "corrupt" }),
    );
    const truncatedJpeg = jpegBytes().subarray(0, 12);
    expect(() => validateImageBytes(truncatedJpeg)).toThrow(
      expect.objectContaining({ code: "corrupt" }),
    );
  });

  it("requires the filename to match the verified bytes", () => {
    const id = attemptId(1);
    expect(
      validateImageBytes(pngBytes(), {
        filename: buildAttemptFilename("P01", id, "png"),
      }).format,
    ).toBe("png");
    expect(() =>
      validateImageBytes(jpegBytes(), {
        filename: buildAttemptFilename("P01", id, "png"),
      }),
    ).toThrow(expect.objectContaining({ code: "filename-mismatch" }));
  });

  it("rejects truncated WebP and trailing bytes after the declared payload", () => {
    expect(() =>
      validateImageBytes(webpVp8lBytes().subarray(0, 10)),
    ).toThrow(expect.objectContaining({ code: "corrupt" }));
    expect(() =>
      validateImageBytes(Buffer.concat([webpVp8lBytes(), Buffer.from([0])])),
    ).toThrow(expect.objectContaining({ code: "corrupt" }));
    expect(() =>
      validateImageBytes(Buffer.concat([pngBytes(), Buffer.from("IEND")])),
    ).toThrow(expect.objectContaining({ code: "corrupt" }));
  });

  it("builds and parses only canonical product/attempt filenames", () => {
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
      validateImageBytes(pngBytes(), {
        filename: `P01-${id.toUpperCase()}.PNG`,
      }).format,
    ).toBe("png");
    expect(() => buildAttemptFilename("P01", "not-a-uuid", "png")).toThrow(
      ImageValidationError,
    );
  });
});
