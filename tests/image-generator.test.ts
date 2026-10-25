import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateOneImage,
  ImageGeneratorError,
  type GenerateOneImageOptions,
} from "../src/server/image-generator";
import {
  loadImageManifest,
  PRODUCT_IDS,
} from "../src/server/image-state";
import {
  buildAttemptFilename,
  MAX_IMAGE_BYTES,
} from "../src/server/image-validation";
import { OpenRouterConfigError } from "../src/server/openrouter";
import { Storage } from "../src/server/storage";
import { attemptId, pngBytes, svgBytes } from "./helpers/image-fixtures";
import type { ImageModelSelection } from "../src/lib/schemas";

const tempDirs: string[] = [];
const servers: Server[] = [];

interface ImageRequest {
  readonly body: Record<string, unknown> | null;
  readonly authorization: string | undefined;
}

const selection: ImageModelSelection = {
  modelId: "black-forest-labs/flux-3-image-klein",
  resolution: "768",
  aspectRatio: "1:1",
  format: "png",
  n: 1,
};

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-generator-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

async function startMock(
  respond: (
    request: ImageRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<{ env: Record<string, string>; requests: ImageRequest[] }> {
  const requests: ImageRequest[] = [];
  const server = createServer(async (incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    const request: ImageRequest = {
      body,
      authorization: incoming.headers.authorization,
    };
    requests.push(request);
    await respond(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    env: {
      LAB_TEST_MODE: "1",
      OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
      DATA_DIR: join(tmpdir(), "ai-browser-lab-generator-test-data"),
    },
    requests,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function imageResponse(
  bytes: Buffer,
  options: {
    readonly mediaType?: string;
    readonly cost?: number;
    readonly provider?: string;
  } = {},
): unknown {
  return {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    data: [
      {
        b64_json: bytes.toString("base64"),
        media_type: options.mediaType ?? "image/png",
      },
    ],
    usage: options.cost === undefined ? undefined : { cost: options.cost },
  };
}

async function run(
  storage: Storage,
  env: Record<string, string>,
  overrides: Partial<GenerateOneImageOptions> = {},
) {
  return generateOneImage({
    storage,
    productId: "P01",
    prompt: "A red panda astronaut, studio product shot",
    apiKey: "sk-or-v1-test-key",
    selection,
    providerOnly: ["cheap"],
    env,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("one-image adapter", () => {
  it("records the started attempt before the request and publishes a validated image", async () => {
    const storage = await makeStorage();
    const id = attemptId(1);
    const imageBytes = pngBytes(48, 48);
    let startedBeforeRequest = false;
    let fileAbsentBeforeRequest = false;

    const mock = await startMock(async (_request, response) => {
      const manifest = await loadImageManifest(storage);
      const attempt = manifest.products.P01?.attempts.find(
        (candidate) => candidate.attemptId === id,
      );
      startedBeforeRequest = attempt?.status === "started";
      fileAbsentBeforeRequest =
        (await storage.readFile([
          "images",
          buildAttemptFilename("P01", id, "png"),
        ])) === undefined;
      json(response, 200, imageResponse(imageBytes, { cost: 0.008 }));
    });

    const result = await run(storage, mock.env, { attemptId: id });
    expect(result).toMatchObject({
      status: "succeeded",
      productId: "P01",
      attemptId: id,
      httpStatus: 200,
      cost: { kind: "reported", usd: 0.008 },
    });
    expect(startedBeforeRequest).toBe(true);
    expect(fileAbsentBeforeRequest).toBe(true);

    const manifest = await loadImageManifest(storage);
    expect(manifest.products.P01?.active).toMatchObject({
      attemptId: id,
      filename: buildAttemptFilename("P01", id, "png"),
      width: 48,
      height: 48,
      format: "png",
      mediaType: "image/png",
    });
    expect(manifest.products.P01?.attempts[0]).toMatchObject({
      status: "succeeded",
      attemptId: id,
    });
    expect(
      await storage.readFile(["images", buildAttemptFilename("P01", id, "png")]),
    ).toBeDefined();

    expect(mock.requests).toEqual([
      {
        authorization: "Bearer sk-or-v1-test-key",
        body: expect.objectContaining({
          model: "black-forest-labs/flux-3-image-klein",
          n: 1,
          resolution: "768",
          aspect_ratio: "1:1",
          output_format: "png",
          provider: { only: ["cheap"] },
        }),
      },
    ]);
  });

  it("never deletes an earlier success when a new attempt becomes active", async () => {
    const storage = await makeStorage();
    const firstId = attemptId(2);
    const secondId = attemptId(3);
    const firstBytes = pngBytes(32, 32);
    const secondBytes = pngBytes(64, 64);

    const firstMock = await startMock((_request, response) => {
      json(response, 200, imageResponse(firstBytes, { cost: 0.008 }));
    });
    const first = await run(storage, firstMock.env, { attemptId: firstId });
    expect(first.status).toBe("succeeded");

    const secondMock = await startMock((_request, response) => {
      json(response, 200, imageResponse(secondBytes, { cost: 0.008 }));
    });
    const second = await run(storage, secondMock.env, { attemptId: secondId });
    expect(second.status).toBe("succeeded");

    const manifest = await loadImageManifest(storage);
    expect(manifest.products.P01?.attempts).toHaveLength(2);
    expect(manifest.products.P01?.active?.attemptId).toBe(secondId);
    const firstFilename = buildAttemptFilename("P01", firstId, "png");
    const secondFilename = buildAttemptFilename("P01", secondId, "png");
    expect(firstFilename).not.toBe(secondFilename);
    expect(await storage.readFile(["images", firstFilename])).toBeDefined();
    expect(await storage.readFile(["images", secondFilename])).toBeDefined();
    expect(PRODUCT_IDS).toContain("P01");
  });

  it.each([
    [401, {}, "unauthorized", 401],
    [402, {}, "insufficient-credit", 402],
    [429, {}, "rate-limited", 429],
    [500, {}, "provider-error", 500],
  ] as const)(
    "maps HTTP %i to %s without publishing",
    async (status, _unused, code, expectedStatus) => {
      const storage = await makeStorage();
      const mock = await startMock((_request, response) => {
        json(response, status, { error: { message: "provider detail" } });
      });
      const result = await run(storage, mock.env, { attemptId: attemptId(10) });
      expect(result).toMatchObject({
        status: "failed",
        code,
        httpStatus: expectedStatus,
      });
      const manifest = await loadImageManifest(storage);
      expect(manifest.products.P01?.active).toBeNull();
      expect(manifest.products.P01?.attempts[0]?.status).toBe("failed");
    },
  );

  it("rejects malformed, SVG, oversized-dimension, and mismatched-format payloads", async () => {
    const cases: Array<{
      readonly name: string;
      readonly respond: (response: ServerResponse) => void;
      readonly code: string;
    }> = [
      {
        name: "not json",
        respond: (response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("not json");
        },
        code: "invalid-response",
      },
      {
        name: "no data",
        respond: (response) => json(response, 200, { data: [] }),
        code: "invalid-response",
      },
      {
        name: "bad base64",
        respond: (response) =>
          json(response, 200, { data: [{ b64_json: "!!!not base64!!!" }] }),
        code: "invalid-response",
      },
      {
        name: "svg",
        respond: (response) =>
          json(
            response,
            200,
            imageResponse(svgBytes, { mediaType: "image/svg+xml" }),
          ),
        code: "image-invalid",
      },
      {
        name: "too-large dimensions",
        respond: (response) =>
          json(response, 200, imageResponse(pngBytes(9000, 16))),
        code: "image-invalid",
      },
      {
        name: "format mismatch",
        respond: (response) =>
          json(response, 200, imageResponse(pngBytes(32, 32))),
        code: "format-mismatch",
      },
    ];

    for (const testCase of cases) {
      const storage = await makeStorage();
      const mock = await startMock((_request, response) =>
        testCase.respond(response),
      );
      const overrides =
        testCase.code === "format-mismatch"
          ? { selection: { ...selection, format: "webp" as const } }
          : {};
      const result = await run(storage, mock.env, {
        attemptId: attemptId(20),
        ...overrides,
      });
      expect(result, testCase.name).toMatchObject({
        status: "failed",
        code: testCase.code,
      });
      const manifest = await loadImageManifest(storage);
      expect(manifest.products.P01?.active, testCase.name).toBeNull();
      expect(manifest.products.P01?.attempts[0]?.status, testCase.name).toBe(
        "failed",
      );
      expect(
        await storage.readFile([
          "images",
          buildAttemptFilename("P01", attemptId(20), "png"),
        ]),
        testCase.name,
      ).toBeUndefined();
    }
  });

  it("handles network and timeout failures with unknown cost and no publish", async () => {
    const storage = await makeStorage();
    const network = await startMock((_request, response) => {
      response.destroy();
    });
    const networkResult = await run(storage, network.env, {
      attemptId: attemptId(30),
    });
    expect(networkResult).toMatchObject({ status: "failed", code: "network" });
    expect(
      (await loadImageManifest(storage)).products.P01?.attempts[0]?.cost,
    ).toEqual({ kind: "unknown" });

    const timeout = await startMock((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":');
      setTimeout(() => response.end("[]}"), 300);
    });
    const timeoutResult = await run(storage, timeout.env, {
      attemptId: attemptId(31),
      timeoutMs: 30,
    });
    expect(timeoutResult).toMatchObject({ status: "failed", code: "timeout" });
    expect(timeoutResult.status === "failed" ? timeoutResult.message : "").toMatch(
      /may still charge/,
    );
    expect((await loadImageManifest(storage)).products.P01?.active).toBeNull();
  });

  it("preserves the earlier active image when a later attempt fails", async () => {
    const storage = await makeStorage();
    const firstId = attemptId(60);
    const secondId = attemptId(61);
    const firstMock = await startMock((_request, response) => {
      json(response, 200, imageResponse(pngBytes(32, 32), { cost: 0.008 }));
    });
    expect((await run(storage, firstMock.env, { attemptId: firstId })).status).toBe(
      "succeeded",
    );

    const failingMock = await startMock((_request, response) => {
      json(response, 429, { error: { message: "slow down" } });
    });
    const failed = await run(storage, failingMock.env, { attemptId: secondId });
    expect(failed).toMatchObject({ status: "failed", code: "rate-limited" });

    const manifest = await loadImageManifest(storage);
    expect(manifest.products.P01?.active?.attemptId).toBe(firstId);
    expect(manifest.products.P01?.attempts).toHaveLength(2);
    expect(manifest.products.P01?.attempts[1]?.status).toBe("failed");
    expect(
      await storage.readFile([
        "images",
        buildAttemptFilename("P01", firstId, "png"),
      ]),
    ).toBeDefined();
  });

  it("rejects oversized responses and decoded images, provider and media-type mismatches", async () => {
    const storage = await makeStorage();
    const oversizedHttp = await startMock((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: "A".repeat(200) }] }));
    });
    expect(
      await run(storage, oversizedHttp.env, {
        attemptId: attemptId(70),
        maxBytes: 64,
      }),
    ).toMatchObject({ status: "failed", code: "invalid-response" });

    const decodedTooLarge = await startMock((_request, response) => {
      json(
        response,
        200,
        imageResponse(Buffer.alloc(MAX_IMAGE_BYTES + 1, 1)),
      );
    });
    expect(
      await run(storage, decodedTooLarge.env, { attemptId: attemptId(71) }),
    ).toMatchObject({ status: "failed", code: "invalid-response" });

    const wrongMediaType = await startMock((_request, response) => {
      json(
        response,
        200,
        imageResponse(pngBytes(32, 32), { mediaType: "image/webp" }),
      );
    });
    expect(
      await run(storage, wrongMediaType.env, { attemptId: attemptId(72) }),
    ).toMatchObject({ status: "failed", code: "format-mismatch" });

    const wrongProvider = await startMock((_request, response) => {
      json(
        response,
        200,
        imageResponse(pngBytes(32, 32), { provider: "unquoted-provider" }),
      );
    });
    expect(
      await run(storage, wrongProvider.env, { attemptId: attemptId(73) }),
    ).toMatchObject({ status: "failed", code: "provider-mismatch" });
    expect((await loadImageManifest(storage)).products.P01?.active).toBeNull();
  });

  it("serializes overlapping calls so no attempt record is lost", async () => {
    const storage = await makeStorage();
    const mock = await startMock(async (request, response) => {
      const prompt = String(request.body?.prompt ?? "");
      const bytes = prompt.includes("P02") ? pngBytes(40, 40) : pngBytes(32, 32);
      json(response, 200, imageResponse(bytes, { cost: 0.008 }));
    });

    const [first, second] = await Promise.all([
      run(storage, mock.env, {
        productId: "P01",
        prompt: "P01 product shot",
        attemptId: attemptId(80),
      }),
      run(storage, mock.env, {
        productId: "P02",
        prompt: "P02 product shot",
        attemptId: attemptId(81),
      }),
    ]);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");

    const manifest = await loadImageManifest(storage);
    expect(manifest.products.P01?.attempts).toHaveLength(1);
    expect(manifest.products.P02?.attempts).toHaveLength(1);
    expect(manifest.products.P01?.active?.attemptId).toBe(attemptId(80));
    expect(manifest.products.P02?.active?.attemptId).toBe(attemptId(81));
  });

  it("rejects malformed key formats before recording an attempt", async () => {
    const storage = await makeStorage();
    const mock = await startMock((_request, response) => {
      json(response, 200, imageResponse(pngBytes(32, 32)));
    });
    await expect(
      run(storage, mock.env, {
        attemptId: attemptId(90),
        apiKey: "sk-or v1 invalid",
      }),
    ).rejects.toThrow(ImageGeneratorError);
    expect(mock.requests).toEqual([]);
    expect(
      (await loadImageManifest(storage)).products.P01?.attempts,
    ).toHaveLength(0);
  });

  it("refuses to overwrite an existing per-attempt file without calling the provider", async () => {
    const storage = await makeStorage();
    const id = attemptId(40);
    const filename = buildAttemptFilename("P01", id, "png");
    await storage.writeFile(["images", filename], Buffer.from("existing"));

    const mock = await startMock((_request, response) => {
      json(response, 200, imageResponse(pngBytes(32, 32)));
    });
    const result = await run(storage, mock.env, { attemptId: id });
    expect(result).toMatchObject({ status: "failed", code: "file-exists" });
    expect(mock.requests).toEqual([]);
    expect(await storage.readFile(["images", filename])).toEqual(
      Buffer.from("existing"),
    );
    const manifest = await loadImageManifest(storage);
    expect(manifest.products.P01?.active).toBeNull();
    expect(manifest.products.P01?.attempts[0]?.status).toBe("failed");
  });

  it("records estimated or unknown cost when usage is missing", async () => {
    const storage = await makeStorage();
    const mock = await startMock((_request, response) => {
      json(response, 200, imageResponse(pngBytes(32, 32)));
    });
    const estimated = await run(storage, mock.env, {
      attemptId: attemptId(50),
      estimatedUnitPriceUsd: "0.008",
    });
    expect(estimated).toMatchObject({
      status: "succeeded",
      cost: { kind: "estimated", usd: 0.008 },
    });

    const storage2 = await makeStorage();
    const mock2 = await startMock((_request, response) => {
      json(response, 200, imageResponse(pngBytes(32, 32)));
    });
    const unknown = await run(storage2, mock2.env, { attemptId: attemptId(51) });
    expect(unknown).toMatchObject({ status: "succeeded", cost: { kind: "unknown" } });
  });

  it("cannot route production traffic to a loopback mock override", async () => {
    const storage = await makeStorage();
    const mock = await startMock((_request, response) => {
      json(response, 200, imageResponse(pngBytes(32, 32)));
    });

    await expect(
      run(storage, {
        OPENROUTER_BASE_URL: mock.env.OPENROUTER_BASE_URL ?? "",
        DATA_DIR: mock.env.DATA_DIR ?? "",
      }),
    ).rejects.toThrow(OpenRouterConfigError);

    await expect(
      run(storage, {
        LAB_TEST_MODE: "1",
        DATA_DIR: mock.env.DATA_DIR ?? "",
        OPENROUTER_BASE_URL: "http://192.168.1.10:4311/api/v1",
      }),
    ).rejects.toThrow(OpenRouterConfigError);

    // A real remembered key lives in the project's normal data directory; the
    // mock override must refuse that directory even in explicit test mode.
    await expect(
      run(storage, {
        LAB_TEST_MODE: "1",
        DATA_DIR: join(process.cwd(), "data"),
        OPENROUTER_BASE_URL: mock.env.OPENROUTER_BASE_URL ?? "",
      }),
    ).rejects.toThrow(/temporary DATA_DIR/);

    expect(mock.requests).toEqual([]);
    const manifest = await loadImageManifest(storage);
    expect(manifest.products.P01?.attempts).toHaveLength(0);
  });
});
