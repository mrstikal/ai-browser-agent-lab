import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

export const MOCK_OPENROUTER_MODEL_ID = "black-forest-labs/flux-3-image-klein";
export const MOCK_OPENROUTER_PROVIDER_SLUG = "mock-provider";
export const MOCK_OPENROUTER_UNIT_PRICE_USD = 0.008;
export const MOCK_OPENROUTER_KEY = "sk-or-v1-e2e-dummy-mock-key";

const MAX_BODY_BYTES = 64 * 1024;

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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** Real, decodable RGBA PNG; validation now forces a bounded decode. */
function pngBytes(width = 32, height = 32) {
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

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) return { ok: false, code: "too-large" };
    chunks.push(Buffer.from(chunk));
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, code: "invalid-json" };
  }
}

function freshStats() {
  return {
    keyRequests: 0,
    modelListRequests: 0,
    endpointRequests: 0,
    imageRequests: 0,
    unauthorizedRequests: 0,
    foreignAuthorization: 0,
    invalidImageRequests: 0,
    lastImageRequest: null,
  };
}

/**
 * Loopback-only OpenRouter stand-in for deterministic E2E runs. It accepts
 * exactly one configured dummy key, never logs authorization values, and
 * exposes counters under /__mock so a test can prove that only the mock was
 * contacted and that the confirmed provider pin reached the request.
 */
export async function startMockOpenRouter(options = {}) {
  const key = options.key ?? MOCK_OPENROUTER_KEY;
  const modelId = options.modelId ?? MOCK_OPENROUTER_MODEL_ID;
  const providerSlug = options.providerSlug ?? MOCK_OPENROUTER_PROVIDER_SLUG;
  const unitPriceUsd = options.unitPriceUsd ?? MOCK_OPENROUTER_UNIT_PRICE_USD;
  let stats = freshStats();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (request.method === "GET" && path === "/__mock/stats") {
      json(response, 200, stats);
      return;
    }
    if (request.method === "POST" && path === "/__mock/reset") {
      stats = freshStats();
      json(response, 200, { ok: true });
      return;
    }

    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${key}`) {
      stats.unauthorizedRequests += 1;
      if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
        stats.foreignAuthorization += 1;
      }
      json(response, 401, { error: { message: "invalid mock key" } });
      return;
    }

    if (request.method === "GET" && path === "/api/v1/key") {
      stats.keyRequests += 1;
      json(response, 200, { data: {} });
      return;
    }

    if (request.method === "GET" && path === "/api/v1/images/models") {
      stats.modelListRequests += 1;
      json(response, 200, {
        data: [
          {
            id: modelId,
            architecture: { output_modalities: ["image"] },
          },
        ],
      });
      return;
    }

    const endpointMatch = /^\/api\/v1\/images\/models\/(.+)\/endpoints$/.exec(path);
    if (request.method === "GET" && endpointMatch?.[1]) {
      let requestedModel;
      try {
        requestedModel = endpointMatch[1]
          .split("/")
          .map((segment) => decodeURIComponent(segment))
          .join("/");
      } catch {
        json(response, 400, { error: { message: "invalid model path" } });
        return;
      }
      if (requestedModel !== modelId) {
        json(response, 404, { error: { message: "unknown model" } });
        return;
      }
      stats.endpointRequests += 1;
      json(response, 200, {
        id: modelId,
        endpoints: [
          {
            provider_slug: providerSlug,
            provider_tag: providerSlug,
            supported_parameters: {
              resolution: { type: "enum", values: ["768"] },
              aspect_ratio: { type: "enum", values: ["1:1"] },
              output_format: { type: "enum", values: ["png"] },
              n: { type: "range", min: 1, max: 1 },
            },
            pricing: [
              {
                billable: "output_image",
                unit: "image",
                cost_usd: unitPriceUsd,
                variant: "768",
              },
            ],
          },
        ],
      });
      return;
    }

    if (request.method === "POST" && path === "/api/v1/images") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        stats.invalidImageRequests += 1;
        json(response, body.code === "too-large" ? 413 : 400, {
          error: { message: body.code },
        });
        return;
      }
      const value = body.value;
      const providerOnly =
        value &&
        typeof value === "object" &&
        value.provider &&
        Array.isArray(value.provider.only)
          ? value.provider.only
          : null;
      if (
        !value ||
        typeof value !== "object" ||
        value.model !== modelId ||
        value.n !== 1 ||
        value.resolution !== "768" ||
        value.aspect_ratio !== "1:1" ||
        value.output_format !== "png" ||
        !providerOnly ||
        !providerOnly.includes(providerSlug) ||
        typeof value.prompt !== "string" ||
        value.prompt.length === 0
      ) {
        stats.invalidImageRequests += 1;
        json(response, 400, { error: { message: "invalid image request" } });
        return;
      }
      stats.imageRequests += 1;
      stats.lastImageRequest = {
        model: value.model,
        n: value.n,
        resolution: value.resolution,
        aspectRatio: value.aspect_ratio,
        outputFormat: value.output_format,
        providerOnly,
        promptLength: value.prompt.length,
      };
      json(response, 200, {
        provider: providerSlug,
        data: [
          {
            b64_json: pngBytes(32, 32).toString("base64"),
            media_type: "image/png",
          },
        ],
        usage: { cost: unitPriceUsd },
      });
      return;
    }

    json(response, 404, { error: { message: "not found" } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine the mock OpenRouter port.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    key,
    origin,
    baseUrl: `${origin}/api/v1`,
    statsUrl: `${origin}/__mock/stats`,
    resetUrl: `${origin}/__mock/reset`,
    get stats() {
      return stats;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
