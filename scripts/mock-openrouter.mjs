import { createServer } from "node:http";

export const MOCK_OPENROUTER_MODEL_ID = "black-forest-labs/flux-3-image-klein";
export const MOCK_OPENROUTER_PROVIDER_SLUG = "mock-provider";
export const MOCK_OPENROUTER_UNIT_PRICE_USD = 0.008;
export const MOCK_OPENROUTER_KEY = "sk-or-v1-e2e-dummy-mock-key";

const MAX_BODY_BYTES = 64 * 1024;

function writeUInt32BE(buffer, value, offset) {
  buffer.writeUInt32BE(value >>> 0, offset);
}

/** Minimal valid PNG; the app validates bytes, format, and dimensions. */
function pngBytes(width = 32, height = 32) {
  const buffer = Buffer.alloc(8 + 25 + 12);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  writeUInt32BE(buffer, 13, 8);
  buffer.write("IHDR", 12, "ascii");
  writeUInt32BE(buffer, width, 16);
  writeUInt32BE(buffer, height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  writeUInt32BE(buffer, 0, 33);
  buffer.write("IEND", 37, "ascii");
  return buffer;
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
