import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as imageRoute from "@/app/api/images/[productId]/route";
import {
  loadDeliverableImageBytes,
  loadDeliverableImages,
} from "@/server/image-delivery";
import {
  appendStartedAttempt,
  loadImageManifest,
  publishAttempt,
  saveImageManifest,
} from "@/server/image-state";
import { buildAttemptFilename, validateImageBytes } from "@/server/image-validation";
import { Storage } from "@/server/storage";
import {
  attemptId,
  jpegBytes,
  pngBytes,
  webpVp8lBytes,
} from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-delivery-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

async function publishImage(
  storage: Storage,
  productId: "P01" | "P02" | "P03",
  bytes: Buffer,
  index: number,
): Promise<{ filename: string; sha256: string }> {
  const id = attemptId(index);
  let manifest = await loadImageManifest(storage);
  manifest = appendStartedAttempt(manifest, productId, id, {
    startedAt: new Date(Date.now() - 5000),
  });
  const filename = buildAttemptFilename(productId, id, "png");
  await storage.writeFile(["images", filename], bytes);
  const validated = validateImageBytes(bytes, { filename });
  manifest = publishAttempt(manifest, productId, id, {
    filename,
    validation: validated,
    publishedAt: new Date(),
    finishedAt: new Date(),
  });
  await saveImageManifest(storage, manifest);
  return { filename, sha256: validated.sha256 };
}

function requestFor(productId: string, headers: HeadersInit = {}): Promise<Response> {
  return imageRoute.GET(new Request(`http://127.0.0.1:3000/api/images/${productId}`, { headers }), {
    params: Promise.resolve({ productId }),
  });
}

beforeEach(async () => {
  const storage = await makeStorage();
  process.env.DATA_DIR = storage.root;
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = { ...originalEnv };
});

describe("validated image delivery", () => {
  it("serves a validated active image with safe headers and an ETag", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const bytes = pngBytes(64, 64);
    const published = await publishImage(storage, "P01", bytes, 1);

    const response = await requestFor("P01");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe(`"${published.sha256}"`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    const notModified = await requestFor("P01", {
      "if-none-match": `"${published.sha256}"`,
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
  });

  it("never serves a stale image after regeneration", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const first = await publishImage(storage, "P01", pngBytes(32, 32), 2);
    const firstResponse = await requestFor("P01");
    const firstEtag = firstResponse.headers.get("etag");
    expect(firstEtag).toBe(`"${first.sha256}"`);

    const second = await publishImage(storage, "P01", pngBytes(96, 96), 3);
    const secondResponse = await requestFor("P01");
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get("etag")).toBe(`"${second.sha256}"`);
    expect(Buffer.from(await secondResponse.arrayBuffer())).toEqual(pngBytes(96, 96));

    const conditional = await requestFor("P01", {
      "if-none-match": firstEtag ?? "",
    });
    expect(conditional.status).toBe(200);
    expect(conditional.headers.get("etag")).toBe(`"${second.sha256}"`);
  });

  it("returns 404 for missing, corrupt, or unknown images", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    await publishImage(storage, "P01", pngBytes(32, 32), 4);
    await publishImage(storage, "P02", pngBytes(32, 32), 5);
    // Corrupt the P02 file after publishing.
    const manifest = await loadImageManifest(storage);
    const p02Filename = manifest.products.P02?.active?.filename;
    if (!p02Filename) throw new Error("Missing P02 active.");
    await storage.writeFile(["images", p02Filename], Buffer.from("corrupt"));
    // Missing P03 entirely.
    expect((await requestFor("P03")).status).toBe(404);
    expect((await requestFor("P99")).status).toBe(404);
    expect((await requestFor("P00")).status).toBe(404);
    expect((await requestFor("p01")).status).toBe(404);
    expect((await requestFor("..")).status).toBe(404);
    expect((await requestFor("..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await requestFor("P01/../../package.json")).status).toBe(404);
    expect((await requestFor("P02")).status).toBe(404);
    expect((await requestFor("P01")).status).toBe(200);
  });

  it("serves JPEG and WebP with their validated media types", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const jpegId = attemptId(8);
    let manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, "P01", jpegId, {
      startedAt: new Date(Date.now() - 5000),
    });
    const jpegName = buildAttemptFilename("P01", jpegId, "jpeg");
    await storage.writeFile(["images", jpegName], jpegBytes(40, 30));
    manifest = publishAttempt(manifest, "P01", jpegId, {
      filename: jpegName,
      validation: validateImageBytes(jpegBytes(40, 30), { filename: jpegName }),
      publishedAt: new Date(),
      finishedAt: new Date(),
    });
    await saveImageManifest(storage, manifest);

    const jpegResponse = await requestFor("P01");
    expect(jpegResponse.status).toBe(200);
    expect(jpegResponse.headers.get("content-type")).toBe("image/jpeg");

    const webpId = attemptId(9);
    manifest = await loadImageManifest(storage);
    manifest = appendStartedAttempt(manifest, "P02", webpId, {
      startedAt: new Date(Date.now() - 5000),
    });
    const webpName = buildAttemptFilename("P02", webpId, "webp");
    const webpBytes = webpVp8lBytes(48, 32);
    await storage.writeFile(["images", webpName], webpBytes);
    manifest = publishAttempt(manifest, "P02", webpId, {
      filename: webpName,
      validation: validateImageBytes(webpBytes, { filename: webpName }),
      publishedAt: new Date(),
      finishedAt: new Date(),
    });
    await saveImageManifest(storage, manifest);

    const webpResponse = await requestFor("P02");
    expect(webpResponse.status).toBe(200);
    expect(webpResponse.headers.get("content-type")).toBe("image/webp");
  });

  it("rejects a manifest whose recorded hash does not match the file", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const bytes = pngBytes(32, 32);
    await publishImage(storage, "P01", bytes, 10);

    const raw = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        storage.path(["images", "manifest.json"]),
        "utf8",
      ),
    ) as {
      products: Record<
        string,
        {
          active: { sha256: string } | null;
          attempts: Array<{ sha256: string | null }>;
        }
      >;
    };
    const wrongHash = "0".repeat(64);
    const p01 = raw.products.P01;
    if (!p01?.active || !p01.attempts[0]) throw new Error("Missing P01 entry.");
    p01.active.sha256 = wrongHash;
    p01.attempts[0].sha256 = wrongHash;
    await storage.writeJson(["images", "manifest.json"], raw);

    expect(await loadDeliverableImageBytes(storage, "P01")).toBeNull();
    expect((await requestFor("P01")).status).toBe(404);
    expect((await loadDeliverableImages(storage)).has("P01")).toBe(false);
  });

  it("answers conditional requests for weak, list, and star ETags", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const published = await publishImage(storage, "P01", pngBytes(32, 32), 11);

    for (const header of [
      `W/"${published.sha256}"`,
      `"other", "${published.sha256}"`,
      "*",
    ]) {
      const response = await requestFor("P01", { "if-none-match": header });
      expect(response.status, header).toBe(304);
    }
  });

  it("falls back safely when the manifest itself is unreadable", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    await storage.writeFile(["images", "manifest.json"], "{bad json");
    expect(await loadDeliverableImageBytes(storage, "P01")).toBeNull();
    expect((await requestFor("P01")).status).toBe(404);
    expect(await loadDeliverableImages(storage)).toEqual(new Map());
  });

  it("only exposes validated products in the catalog delivery map", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    await publishImage(storage, "P01", pngBytes(32, 32), 6);
    await publishImage(storage, "P02", pngBytes(32, 32), 7);
    const manifest = await loadImageManifest(storage);
    const p02Filename = manifest.products.P02?.active?.filename;
    if (!p02Filename) throw new Error("Missing P02 active.");
    await storage.writeFile(["images", p02Filename], Buffer.from("corrupt"));

    const delivered = await loadDeliverableImages(storage);
    expect([...delivered.keys()]).toEqual(["P01"]);
    expect(delivered.get("P01")?.url).toBe(
      `/api/images/P01?v=${(await loadDeliverableImageBytes(storage, "P01"))?.sha256.slice(0, 16)}`,
    );
  });
});
