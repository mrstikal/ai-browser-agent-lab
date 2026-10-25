import type { ImageModelSelection } from "../lib/schemas";
import {
  fetchOpenRouterJson,
  openRouterEndpoint,
  resolveOpenRouterBaseUrl,
  type FetchOpenRouterJsonResult,
} from "./openrouter";
import type { StorageEnv } from "./storage";
import { decimalStringFromNumber, parseUsdToMicro } from "./usd";

export const DEFAULT_IMAGE_CATALOG_MAX_BYTES = 1024 * 1024;

export interface ImageModelCapabilities {
  readonly modelId: string;
  readonly providerSlug: string;
  /**
   * Full routing tag (`provider[/variant][/region][/tier]`). OpenRouter's
   * `provider.only` matches a base slug to every endpoint variant, so the
   * quote must pin this exact tag to keep the approved capabilities and price.
   */
  readonly providerTag: string;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly format: "png" | "jpeg" | "webp";
  readonly unitPriceUsd: string;
}

export type ImageCapabilitiesResult =
  | { readonly status: "verified"; readonly capabilities: ImageModelCapabilities }
  | { readonly status: "key-required" }
  | { readonly status: "key-rejected" }
  | { readonly status: "stale-model" }
  | { readonly status: "unverified-capabilities" }
  | { readonly status: "unknown-price" }
  | {
      readonly status: "unavailable";
      readonly httpStatus: number | null;
      readonly reason: "network" | "timeout" | null;
    }
  | { readonly status: "invalid-response"; readonly httpStatus: number | null };

export interface FetchImageCapabilitiesOptions {
  readonly apiKey: string | undefined;
  readonly env?: StorageEnv | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function routingIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function descriptorAllowsString(descriptor: unknown, value: string): boolean {
  if (!isRecord(descriptor)) return false;
  if (descriptor.type !== "enum" || !Array.isArray(descriptor.values)) {
    return false;
  }
  return descriptor.values.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.toLowerCase() === value.toLowerCase(),
  );
}

function descriptorAllowsSingle(descriptor: unknown): boolean {
  if (descriptor === undefined || descriptor === null) return true;
  if (!isRecord(descriptor)) return false;
  if (descriptor.type === "range") {
    return (
      typeof descriptor.min === "number" &&
      typeof descriptor.max === "number" &&
      descriptor.min <= 1 &&
      1 <= descriptor.max
    );
  }
  if (descriptor.type === "enum" && Array.isArray(descriptor.values)) {
    return descriptor.values.some((candidate) => candidate === 1);
  }
  return false;
}

interface EligibleEndpoint {
  readonly providerSlug: string;
  readonly providerTag: string;
  readonly unitPriceUsd: string;
  readonly unitMicro: bigint;
}

function pricingForResolution(
  endpoint: Record<string, unknown>,
  resolution: string,
): { unitPriceUsd: string; unitMicro: bigint } | undefined {
  const pricing = endpoint.pricing;
  if (!Array.isArray(pricing)) return undefined;

  const variantPrices: { unitPriceUsd: string; unitMicro: bigint }[] = [];
  const flatPrices: { unitPriceUsd: string; unitMicro: bigint }[] = [];
  for (const entry of pricing) {
    if (!isRecord(entry)) continue;
    if (entry.billable !== "output_image") continue;
    if (entry.unit !== "image") continue;
    const variant = entry.variant;
    if (variant !== undefined && variant !== null) {
      if (
        typeof variant !== "string" ||
        variant.toLowerCase() !== resolution.toLowerCase()
      ) {
        continue;
      }
    }
    const unitPriceUsd = decimalStringFromNumber(entry.cost_usd);
    if (unitPriceUsd === undefined) continue;
    const unitMicro = parseUsdToMicro(unitPriceUsd);
    if (unitMicro === 0n) continue;
    (variant === undefined || variant === null ? flatPrices : variantPrices).push({
      unitPriceUsd,
      unitMicro,
    });
  }

  const candidates = variantPrices.length > 0 ? variantPrices : flatPrices;
  let best: { unitPriceUsd: string; unitMicro: bigint } | undefined;
  for (const candidate of candidates) {
    if (!best || candidate.unitMicro < best.unitMicro) best = candidate;
  }
  return best;
}

function descriptorEligible(
  endpoint: Record<string, unknown>,
  selection: ImageModelSelection,
): boolean {
  const parameters = endpoint.supported_parameters;
  if (!isRecord(parameters)) return false;
  if (!descriptorAllowsString(parameters.resolution, selection.resolution)) {
    return false;
  }
  if (!descriptorAllowsString(parameters.aspect_ratio, selection.aspectRatio)) {
    return false;
  }
  if (!descriptorAllowsString(parameters.output_format, selection.format)) {
    return false;
  }
  return descriptorAllowsSingle(parameters.n);
}

function endpointPath(modelId: string): string {
  const segments = modelId
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return `images/models/${segments.join("/")}/endpoints`;
}

function failureFromFetch(
  fetched: Extract<FetchOpenRouterJsonResult, { ok: false }>,
): ImageCapabilitiesResult {
  if (fetched.kind === "http") {
    if (fetched.status === 401 || fetched.status === 403) {
      return { status: "key-rejected" };
    }
    return { status: "unavailable", httpStatus: fetched.status, reason: null };
  }
  if (fetched.kind === "timeout" || fetched.kind === "network") {
    return { status: "unavailable", httpStatus: null, reason: fetched.kind };
  }
  return { status: "invalid-response", httpStatus: null };
}

/**
 * Reads the model list plus its definitive per-endpoint records through the
 * Phase 10 guarded base URL and returns only the verified selection facts:
 * provider, resolution/aspect/format support, and a flat per-image price.
 * Token- or megapixel-priced endpoints are rejected as unknown rather than
 * silently treated as $0.
 */
export async function fetchImageModelCapabilities(
  selection: ImageModelSelection,
  options: FetchImageCapabilitiesOptions,
): Promise<ImageCapabilitiesResult> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return { status: "key-required" };

  const env = options.env ?? process.env;
  const baseUrl = resolveOpenRouterBaseUrl(env);
  const headers = { authorization: `Bearer ${apiKey}` };
  const fetchOptions = {
    headers,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes ?? DEFAULT_IMAGE_CATALOG_MAX_BYTES,
  };

  const models = await fetchOpenRouterJson(
    openRouterEndpoint(baseUrl, "images/models"),
    fetchOptions,
  );
  if (!models.ok) return failureFromFetch(models);

  const modelsJson = models.json;
  if (!isRecord(modelsJson) || !Array.isArray(modelsJson.data)) {
    return { status: "invalid-response", httpStatus: models.status };
  }
  const modelEntry = modelsJson.data.find(
    (entry) => isRecord(entry) && entry.id === selection.modelId,
  );
  if (!isRecord(modelEntry)) return { status: "stale-model" };

  const architecture = modelEntry.architecture;
  if (
    isRecord(architecture) &&
    Array.isArray(architecture.output_modalities) &&
    !architecture.output_modalities.includes("image")
  ) {
    return { status: "unverified-capabilities" };
  }

  const endpoints = await fetchOpenRouterJson(
    openRouterEndpoint(baseUrl, endpointPath(selection.modelId)),
    fetchOptions,
  );
  if (!endpoints.ok) {
    if (endpoints.kind === "http" && endpoints.status === 404) {
      return { status: "stale-model" };
    }
    return failureFromFetch(endpoints);
  }

  const endpointsJson = endpoints.json;
  if (!isRecord(endpointsJson) || !Array.isArray(endpointsJson.endpoints)) {
    return { status: "invalid-response", httpStatus: endpoints.status };
  }

  const records = endpointsJson.endpoints.filter(isRecord);
  if (records.length === 0) return { status: "unverified-capabilities" };

  const eligible = records.filter((endpoint) =>
    descriptorEligible(endpoint, selection),
  );
  if (eligible.length === 0) return { status: "unverified-capabilities" };

  const priced: EligibleEndpoint[] = [];
  let hasUsablePrice = false;
  for (const endpoint of eligible) {
    const price = pricingForResolution(endpoint, selection.resolution);
    if (!price) continue;
    hasUsablePrice = true;
    const providerSlug = routingIdentifier(endpoint.provider_slug);
    const providerTag = routingIdentifier(endpoint.provider_tag);
    // A base slug alone can match several endpoint variants with different
    // capabilities or prices. Without a full tag the endpoint cannot be pinned
    // to the metadata that was quoted, so it is not eligible for a paid batch.
    if (!providerSlug || !providerTag) continue;
    priced.push({
      providerSlug,
      providerTag,
      unitPriceUsd: price.unitPriceUsd,
      unitMicro: price.unitMicro,
    });
  }
  if (priced.length === 0) {
    return hasUsablePrice
      ? { status: "unverified-capabilities" }
      : { status: "unknown-price" };
  }

  priced.sort((left, right) => {
    if (left.unitMicro !== right.unitMicro) {
      return left.unitMicro < right.unitMicro ? -1 : 1;
    }
    const slug = left.providerSlug.localeCompare(right.providerSlug);
    return slug !== 0 ? slug : left.providerTag.localeCompare(right.providerTag);
  });
  const chosen = priced[0];
  if (!chosen) return { status: "unknown-price" };

  return {
    status: "verified",
    capabilities: {
      modelId: selection.modelId,
      providerSlug: chosen.providerSlug,
      providerTag: chosen.providerTag,
      resolution: selection.resolution,
      aspectRatio: selection.aspectRatio,
      format: selection.format,
      unitPriceUsd: chosen.unitPriceUsd,
    },
  };
}
