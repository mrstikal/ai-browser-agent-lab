import type { ProductId } from "../lib/products";
import {
  inspectActiveImages,
  loadImageManifest,
} from "./image-state";
import { isProductId, validateImageBytes } from "./image-validation";
import { Storage } from "./storage";

export interface DeliverableImage {
  readonly productId: ProductId;
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly url: string;
}

export interface DeliverableImageBytes {
  readonly productId: ProductId;
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export function imageDeliveryUrl(productId: ProductId, sha256: string): string {
  return `/api/images/${productId}?v=${sha256.slice(0, 16)}`;
}

/**
 * Delivery map for the catalog and detail views. Only products whose active
 * file re-validates (format, size, hash, dimensions) are included; everything
 * else stays on the local placeholder.
 */
export async function loadDeliverableImages(
  storage: Storage,
): Promise<Map<string, DeliverableImage>> {
  const result = new Map<string, DeliverableImage>();
  try {
    const manifest = await loadImageManifest(storage);
    const inspections = await inspectActiveImages(storage, manifest);
    for (const inspection of inspections) {
      if (!inspection.valid) continue;
      const active = manifest.products[inspection.productId]?.active;
      if (!active) continue;
      result.set(inspection.productId, {
        productId: inspection.productId,
        filename: active.filename,
        mediaType: active.mediaType,
        sha256: active.sha256,
        byteLength: active.sizeBytes,
        url: imageDeliveryUrl(inspection.productId, active.sha256),
      });
    }
  } catch {
    // Unreadable state means placeholders, never a partial catalog failure.
  }
  return result;
}

/**
 * Validated bytes for the delivery route. Returns null for unknown IDs,
 * missing/corrupt files, metadata mismatches, or unreadable state so callers
 * can answer 404 without leaking storage paths.
 */
export async function loadDeliverableImageBytes(
  storage: Storage,
  productIdValue: string,
): Promise<DeliverableImageBytes | null> {
  if (!isProductId(productIdValue)) return null;
  const productId = productIdValue;
  try {
    const manifest = await loadImageManifest(storage);
    const active = manifest.products[productId]?.active ?? null;
    if (!active) return null;

    const bytes = await storage.readFile(["images", active.filename]);
    if (bytes === undefined) return null;

    const validated = validateImageBytes(bytes, { filename: active.filename });
    if (
      validated.format !== active.format ||
      validated.mediaType !== active.mediaType ||
      validated.sizeBytes !== active.sizeBytes ||
      validated.sha256 !== active.sha256 ||
      validated.width !== active.width ||
      validated.height !== active.height
    ) {
      return null;
    }
    return {
      productId,
      filename: active.filename,
      mediaType: active.mediaType,
      sha256: active.sha256,
      bytes,
    };
  } catch {
    return null;
  }
}
