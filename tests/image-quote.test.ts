import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStartedAttempt,
  createEmptyImageManifest,
  publishAttempt,
  saveImageManifest,
} from "../src/server/image-state";
import { buildAttemptFilename, validateImageBytes } from "../src/server/image-validation";
import {
  resetAdmittedImageJobsForTests,
  startImageJob,
} from "../src/server/image-job";
import { resetPaidOperationsForTests } from "../src/server/paid-operation";
import {
  computeImageQuote,
  isImageQuoteCurrent,
  prepareImageQuote,
} from "../src/server/image-quote";
import type { ImageModelCapabilities } from "../src/server/image-catalog";
import {
  DEFAULT_IMAGE_MODEL_ID,
  loadModelSettings,
  saveModelSettings,
  updateImageSettings,
} from "../src/server/model-settings";
import { Storage } from "../src/server/storage";
import {
  decimalStringFromNumber,
  formatUsdMicro,
  parseUsdToMicro,
  UsdFormatError,
} from "../src/server/usd";
import type { ProductId } from "../src/lib/products";
import { attemptId, pngBytes } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const servers: Server[] = [];

interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
}

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-quote-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startCatalog(
  handler: (path: string, response: ServerResponse) => void,
): Promise<{ env: Record<string, string>; requests: RequestRecord[] }> {
  const requests: RequestRecord[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    requests.push({
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
    });
    handler(path, response);
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
      DATA_DIR: "/tmp/ai-browser-lab-quote-test-data",
    },
    requests,
  };
}

function modelsList(ids: readonly string[]): unknown {
  return {
    data: ids.map((id) => ({
      id,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["image"],
      },
      supported_parameters: {},
    })),
  };
}

interface EndpointOptions {
  readonly resolutionValues?: readonly string[];
  readonly resolutionDescriptor?: unknown;
  readonly aspectValues?: readonly string[];
  readonly formatValues?: readonly string[];
  readonly omitResolution?: boolean;
  readonly nDescriptor?: unknown;
  readonly providerTag?: string | null;
  readonly pricing?: readonly unknown[];
}

function endpoint(providerSlug: string, options: EndpointOptions = {}): unknown {
  const parameters: Record<string, unknown> = {
    aspect_ratio: {
      type: "enum",
      values: options.aspectValues ?? ["1:1", "16:9"],
    },
    output_format: {
      type: "enum",
      values: options.formatValues ?? ["png", "jpeg", "webp"],
    },
    n: options.nDescriptor ?? { type: "range", min: 1, max: 1 },
  };
  if (!options.omitResolution) {
    parameters.resolution =
      options.resolutionDescriptor ?? {
        type: "enum",
        values: options.resolutionValues ?? ["768"],
      };
  }
  return {
    provider_name: providerSlug,
    provider_slug: providerSlug,
    provider_tag:
      options.providerTag === undefined ? providerSlug : options.providerTag,
    allowed_passthrough_parameters: [],
    supports_streaming: false,
    supported_parameters: parameters,
    pricing: options.pricing ?? [
      { billable: "output_image", unit: "image", cost_usd: 0.008, variant: "768" },
    ],
  };
}

function endpointsResponse(endpoints: readonly unknown[]): unknown {
  return { id: DEFAULT_IMAGE_MODEL_ID, endpoints };
}

function withCatalog(
  models: unknown,
  endpoints: unknown,
): (path: string, response: ServerResponse) => void {
  return (path, response) => {
    if (path === "/api/v1/images/models") {
      json(response, 200, models);
      return;
    }
    if (path.includes("/images/models/") && path.endsWith("/endpoints")) {
      json(response, 200, endpoints);
      return;
    }
    json(response, 404, { error: { code: 404, message: "Resource not found" } });
  };
}

async function publishOneValidImage(storage: Storage): Promise<void> {
  const id = attemptId(1);
  let manifest = appendStartedAttempt(createEmptyImageManifest(), "P01", id, {
    startedAt: new Date(Date.now() - 5000),
  });
  const filename = buildAttemptFilename("P01", id, "png");
  const bytes = pngBytes(32, 32);
  await storage.writeFile(["images", filename], bytes);
  manifest = publishAttempt(manifest, "P01", id, {
    filename,
    validation: await validateImageBytes(bytes, { filename }),
    publishedAt: new Date(),
    finishedAt: new Date(),
  });
  await saveImageManifest(storage, manifest);
}

function capability(
  overrides: Partial<ImageModelCapabilities> = {},
): ImageModelCapabilities {
  return {
    modelId: DEFAULT_IMAGE_MODEL_ID,
    providerSlug: "black-forest-labs",
    providerTag: "black-forest-labs",
    resolution: "768",
    aspectRatio: "1:1",
    format: "png",
    unitPriceUsd: "0.008",
    ...overrides,
  };
}

const ALL_PRODUCT_IDS = Array.from(
  { length: 24 },
  (_, index) => `P${String(index + 1).padStart(2, "0")}`,
) as ProductId[];

afterEach(async () => {
  resetPaidOperationsForTests();
  await resetAdmittedImageJobsForTests();
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

describe("USD decimal math", () => {
  it("parses and formats sub-cent amounts exactly", () => {
    expect(parseUsdToMicro("0.008")).toBe(8000n);
    expect(parseUsdToMicro("1")).toBe(1_000_000n);
    expect(parseUsdToMicro("1.184")).toBe(1_184_000n);
    expect(formatUsdMicro(8000n)).toBe("0.008");
    expect(formatUsdMicro(192_000n)).toBe("0.192");
    expect(formatUsdMicro(1_184_000n)).toBe("1.184");
    expect(formatUsdMicro(1_568_000n)).toBe("1.568");
    expect(formatUsdMicro(1_000_000n)).toBe("1.00");
    expect(formatUsdMicro(50_000n)).toBe("0.05");
  });

  it("rejects malformed amounts and unrepresentable numbers", () => {
    for (const bad of ["-1", "1e-3", ".5", "0.0000001", "abc", "1.2.3", ""]) {
      expect(() => parseUsdToMicro(bad)).toThrow(UsdFormatError);
    }
    expect(decimalStringFromNumber(0.008)).toBe("0.008");
    expect(decimalStringFromNumber(0.05)).toBe("0.05");
    expect(decimalStringFromNumber(0.0000001)).toBeUndefined();
    expect(decimalStringFromNumber(-1)).toBeUndefined();
    expect(decimalStringFromNumber("0.008")).toBeUndefined();
  });
});

describe("image quote math", () => {
  it("quotes 24 x $0.008 as $0.192 with a $1.184 starting floor", () => {
    const quote = computeImageQuote(ALL_PRODUCT_IDS, capability());
    expect(quote).toMatchObject({
      imageCount: 24,
      attemptsPerImage: 3,
      unitPriceUsd: "0.008",
      baseUsd: "0.192",
      worstCaseUsd: "0.576",
      startingBalanceBaseUsd: "1.184",
      startingBalanceWorstCaseUsd: "1.568",
      perRequestFloorUsd: "1.00",
      providerSlug: "black-forest-labs",
    });
    expect(quote.targets).toHaveLength(24);
  });

  it("keeps the floor before each request for a single image and other prices", () => {
    const single = computeImageQuote(["P01"], capability());
    expect(single).toMatchObject({
      baseUsd: "0.008",
      worstCaseUsd: "0.024",
      startingBalanceBaseUsd: "1.00",
      startingBalanceWorstCaseUsd: "1.016",
    });

    const nickels = computeImageQuote(ALL_PRODUCT_IDS, capability({ unitPriceUsd: "0.05" }));
    expect(nickels).toMatchObject({
      baseUsd: "1.20",
      worstCaseUsd: "3.60",
      startingBalanceBaseUsd: "2.15",
      startingBalanceWorstCaseUsd: "4.55",
    });
  });

  it("rejects empty targets and unusable prices", () => {
    expect(() => computeImageQuote([], capability())).toThrow(
      expect.objectContaining({ code: "no-targets" }),
    );
    expect(() =>
      computeImageQuote(["P01"], capability({ unitPriceUsd: "unknown" })),
    ).toThrow(expect.objectContaining({ code: "unknown-price" }));
  });

  it("detects stale quotes by fingerprint", () => {
    const accepted = computeImageQuote(ALL_PRODUCT_IDS, capability());
    const same = computeImageQuote(ALL_PRODUCT_IDS, capability());
    const repriced = computeImageQuote(
      ALL_PRODUCT_IDS,
      capability({ unitPriceUsd: "0.009" }),
    );
    const otherProvider = computeImageQuote(
      ALL_PRODUCT_IDS,
      capability({ providerSlug: "other-provider" }),
    );
    const fewerTargets = computeImageQuote(["P01"], capability());
    expect(isImageQuoteCurrent(accepted, same)).toBe(true);
    expect(isImageQuoteCurrent(accepted, repriced)).toBe(false);
    expect(isImageQuoteCurrent(accepted, otherProvider)).toBe(false);
    expect(isImageQuoteCurrent(accepted, fewerTargets)).toBe(false);
  });
});

describe("prepareImageQuote", () => {
  it("builds a verified 24-target quote using GET-only metadata", async () => {
    const storage = await makeStorage();
    const catalog = await startCatalog(
      withCatalog(modelsList([DEFAULT_IMAGE_MODEL_ID]), endpointsResponse([
        endpoint("expensive", {
          pricing: [
            { billable: "output_image", unit: "image", cost_usd: 0.012, variant: "768" },
          ],
        }),
        endpoint("cheap"),
      ])),
    );

    const quote = await prepareImageQuote({
      storage,
      apiKey: "sk-or-v1-test",
      env: catalog.env,
    });
    expect(quote).toMatchObject({
      imageCount: 24,
      unitPriceUsd: "0.008",
      providerSlug: "cheap",
      baseUsd: "0.192",
      startingBalanceBaseUsd: "1.184",
    });
    expect(catalog.requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
    ]);
    expect(catalog.requests.every((request) => request.authorization === "Bearer sk-or-v1-test")).toBe(
      true,
    );
    expect(
      catalog.requests.some((request) =>
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method),
      ),
    ).toBe(false);
  });

  it("computes missing targets from the manifest but honours explicit selections", async () => {
    const storage = await makeStorage();
    await publishOneValidImage(storage);
    const catalog = await startCatalog(
      withCatalog(modelsList([DEFAULT_IMAGE_MODEL_ID]), endpointsResponse([endpoint("cheap")])),
    );

    const missing = await prepareImageQuote({
      storage,
      apiKey: "sk-or-v1-test",
      env: catalog.env,
    });
    expect(missing.targets).toHaveLength(23);
    expect(missing.targets).not.toContain("P01");
    expect(missing.baseUsd).toBe("0.184");
    expect(missing.startingBalanceBaseUsd).toBe("1.176");

    const selected = await prepareImageQuote({
      storage,
      apiKey: "sk-or-v1-test",
      env: catalog.env,
      selectedIds: ["P02", "P01", "P01"],
    });
    expect(selected.targets).toEqual(["P01", "P02"]);
  });

  it("rejects unknown, unverified, and unknown-price capabilities", async () => {
    const storage = await makeStorage();

    const unknownModel = await startCatalog(
      withCatalog(modelsList(["other/model"]), endpointsResponse([endpoint("cheap")])),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: unknownModel.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "stale-model", }));

    const missingResolution = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { omitResolution: true })]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: missingResolution.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unverified-capabilities" }));

    const booleanResolution = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([
          endpoint("cheap", {
            resolutionDescriptor: { type: "boolean" },
          }),
        ]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: booleanResolution.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unverified-capabilities" }));

    const wrongAspect = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { aspectValues: ["16:9"] })]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: wrongAspect.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unverified-capabilities" }));

    const wrongFormat = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { formatValues: ["jpeg"] })]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: wrongFormat.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unverified-capabilities" }));

    const perToken = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([
          endpoint("cheap", {
            pricing: [{ billable: "output_image", unit: "token", cost_usd: 0.001 }],
          }),
        ]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: perToken.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unknown-price" }));

    const otherVariant = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([
          endpoint("cheap", {
            pricing: [
              { billable: "output_image", unit: "image", cost_usd: 0.02, variant: "2k" },
            ],
          }),
        ]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: otherVariant.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unknown-price" }));

    const flatPrice = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([
          endpoint("flat", {
            pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.011 }],
          }),
        ]),
      ),
    );
    const flatQuote = await prepareImageQuote({
      storage,
      apiKey: "sk",
      env: flatPrice.env,
    });
    expect(flatQuote.unitPriceUsd).toBe("0.011");
    expect(flatQuote.providerSlug).toBe("flat");
  });

  it("rejects n, modality, zero-price, and malformed pricing variants", async () => {
    const storage = await makeStorage();

    const nTooHigh = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { nDescriptor: { type: "range", min: 2, max: 4 } })]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: nTooHigh.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unverified-capabilities" }));

    const textOnly = await startCatalog((path, response) => {
      if (path === "/api/v1/images/models") {
        json(response, 200, {
          data: [
            {
              id: DEFAULT_IMAGE_MODEL_ID,
              architecture: { output_modalities: ["text"] },
            },
          ],
        });
        return;
      }
      json(response, 200, endpointsResponse([endpoint("cheap")]));
    });
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: textOnly.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unverified-capabilities" }));

    const zeroPrice = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([
          endpoint("cheap", {
            pricing: [{ billable: "output_image", unit: "image", cost_usd: 0, variant: "768" }],
          }),
        ]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: zeroPrice.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unknown-price" }));

    const missingFields = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { pricing: [{ cost_usd: 0.008 }] })]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: missingFields.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unknown-price" }));

    const megapixel = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([
          endpoint("cheap", {
            pricing: [
              { billable: "output_image", unit: "megapixel", cost_usd: 0.03 },
            ],
          }),
        ]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: megapixel.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unknown-price" }));
  });

  it("prefers the resolution variant over a flat price and reports key rejection", async () => {
    const storage = await makeStorage();

    const variantPrecedence = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([
          endpoint("cheap", {
            pricing: [
              { billable: "output_image", unit: "image", cost_usd: 0.02 },
              { billable: "output_image", unit: "image", cost_usd: 0.008, variant: "768" },
            ],
          }),
        ]),
      ),
    );
    const quote = await prepareImageQuote({
      storage,
      apiKey: "sk",
      env: variantPrecedence.env,
    });
    expect(quote.unitPriceUsd).toBe("0.008");
    expect(quote.providerOnly).toEqual(["cheap"]);

    const unauthorized = await startCatalog((_path, response) => {
      json(response, 401, { error: { message: "Invalid credentials" } });
    });
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: unauthorized.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "key-rejected" }));

    const whitespaceKey = await startCatalog(
      withCatalog(modelsList([DEFAULT_IMAGE_MODEL_ID]), endpointsResponse([endpoint("cheap")])),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "   ", env: whitespaceKey.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "key-required" }));
    expect(whitespaceKey.requests).toEqual([]);
  });

  it("handles endpoints 404, second-request failures, and provider-tag drift", async () => {
    const storage = await makeStorage();

    const endpoints404 = await startCatalog((path, response) => {
      if (path === "/api/v1/images/models") {
        json(response, 200, modelsList([DEFAULT_IMAGE_MODEL_ID]));
        return;
      }
      json(response, 404, { error: { message: "Resource not found" } });
    });
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: endpoints404.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "stale-model" }));

    const endpointsNetwork = await startCatalog((path, response) => {
      if (path === "/api/v1/images/models") {
        json(response, 200, modelsList([DEFAULT_IMAGE_MODEL_ID]));
        return;
      }
      response.destroy();
    });
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: endpointsNetwork.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unavailable", reason: "network" }));

    const tagA = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { providerTag: "tag-a" })]),
      ),
    );
    const first = await prepareImageQuote({ storage, apiKey: "sk", env: tagA.env });
    const tagB = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { providerTag: "tag-b" })]),
      ),
    );
    const second = await prepareImageQuote({ storage, apiKey: "sk", env: tagB.env });
    expect(first.providerTag).toBe("tag-a");
    expect(first.providerOnly).toEqual(["tag-a"]);
    expect(second.providerTag).toBe("tag-b");
    expect(second.providerOnly).toEqual(["tag-b"]);
    expect(isImageQuoteCurrent(first, second)).toBe(false);
  });

  it("drops newly valid targets from a resume and rejects the stale quote", async () => {
    const storage = await makeStorage();
    const catalog = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap")]),
      ),
    );
    const before = await prepareImageQuote({
      storage,
      apiKey: "sk",
      env: catalog.env,
      selectedIds: ["P01", "P02"],
      intent: "resume",
    });
    expect(before.targets).toEqual(["P01", "P02"]);

    await publishOneValidImage(storage);
    const rechecked = await prepareImageQuote({
      storage,
      apiKey: "sk",
      env: catalog.env,
      selectedIds: ["P01", "P02"],
      intent: "resume",
    });
    expect(rechecked.targets).toEqual(["P02"]);
    expect(rechecked.fingerprint).not.toBe(before.fingerprint);

    const started = await startImageJob({
      storage,
      apiKey: "sk",
      env: catalog.env,
      fingerprint: before.fingerprint,
      selectedIds: ["P01", "P02"],
      intent: "resume",
    });
    expect(started.status).toBe("quote-changed");
  });

  it("rejects an endpoint without a usable routing tag", async () => {
    const storage = await makeStorage();
    const catalog = await startCatalog(
      withCatalog(
        modelsList([DEFAULT_IMAGE_MODEL_ID]),
        endpointsResponse([endpoint("cheap", { providerTag: null })]),
      ),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: catalog.env }),
    ).rejects.toMatchObject({ code: "unverified-capabilities" });
  });

  it("wraps settings and manifest corruption into quote codes", async () => {
    const storage = await makeStorage();
    const catalog = await startCatalog(
      withCatalog(modelsList([DEFAULT_IMAGE_MODEL_ID]), endpointsResponse([endpoint("cheap")])),
    );

    await storage.writeFile(["settings.json"], "{not json");
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: catalog.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-settings" }));
    expect(catalog.requests).toEqual([]);

    await storage.deleteFile(["settings.json"]);
    await storage.writeFile(["images", "manifest.json"], "{not json");
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: catalog.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-image-state" }));
    expect(catalog.requests).toEqual([]);
  });

  it("requires a key and validates explicit selections without requests", async () => {
    const storage = await makeStorage();
    const catalog = await startCatalog(
      withCatalog(modelsList([DEFAULT_IMAGE_MODEL_ID]), endpointsResponse([endpoint("cheap")])),
    );

    await expect(
      prepareImageQuote({ storage, apiKey: undefined, env: catalog.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "key-required" }));
    expect(catalog.requests).toEqual([]);

    await expect(
      prepareImageQuote({
        storage,
        apiKey: "sk",
        env: catalog.env,
        selectedIds: ["P99"],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-selection" }));
    await expect(
      prepareImageQuote({
        storage,
        apiKey: "sk",
        env: catalog.env,
        selectedIds: [],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "no-targets" }));
    await expect(
      prepareImageQuote({
        storage,
        apiKey: "sk",
        env: catalog.env,
        selection: {
          modelId: DEFAULT_IMAGE_MODEL_ID,
          resolution: "9K" as never,
          aspectRatio: "1:1",
          format: "png",
          n: 1,
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-selection" }));
    expect(catalog.requests).toEqual([]);
  });

  it("maps upstream failures without a paid request", async () => {
    const storage = await makeStorage();

    const failing = await startCatalog((path, response) => {
      if (path === "/api/v1/images/models") {
        json(response, 500, { error: { message: "boom" } });
        return;
      }
      json(response, 404, { error: {} });
    });
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: failing.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unavailable", httpStatus: 500 }));

    const malformed = await startCatalog((path, response) => {
      if (path === "/api/v1/images/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not json");
        return;
      }
      json(response, 404, { error: {} });
    });
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: malformed.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-response" }));

    const endpointsMissing = await startCatalog(
      withCatalog(modelsList([DEFAULT_IMAGE_MODEL_ID]), { endpoints: [] }),
    );
    await expect(
      prepareImageQuote({ storage, apiKey: "sk", env: endpointsMissing.env }),
    ).rejects.toThrow(expect.objectContaining({ code: "unverified-capabilities" }));
  });

  it("marks a quote stale after the model setting changes", async () => {
    const storage = await makeStorage();
    const catalog = await startCatalog((path, response) => {
      if (path === "/api/v1/images/models") {
        json(response, 200, modelsList([DEFAULT_IMAGE_MODEL_ID, "other/model"]));
        return;
      }
      if (path.includes("/images/models/other/model/endpoints")) {
        json(
          response,
          200,
          endpointsResponse([
            endpoint("other-provider", {
              pricing: [
                { billable: "output_image", unit: "image", cost_usd: 0.02, variant: "768" },
              ],
            }),
          ]),
        );
        return;
      }
      json(response, 200, endpointsResponse([endpoint("cheap")]));
    });

    const accepted = await prepareImageQuote({
      storage,
      apiKey: "sk",
      env: catalog.env,
    });
    const settings = await loadModelSettings(storage);
    await saveModelSettings(
      storage,
      updateImageSettings(settings, {
        ...settings.image,
        modelId: "other/model",
      }),
    );
    const fresh = await prepareImageQuote({
      storage,
      apiKey: "sk",
      env: catalog.env,
    });
    expect(fresh.providerSlug).toBe("other-provider");
    expect(fresh.unitPriceUsd).toBe("0.02");
    expect(isImageQuoteCurrent(accepted, fresh)).toBe(false);

  });
});
