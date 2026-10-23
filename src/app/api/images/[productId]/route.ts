import { loadDeliverableImageBytes } from "@/server/image-delivery";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ImageRouteContext {
  readonly params: Promise<{ readonly productId: string }>;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const tokens = header.split(",").map((token) => token.trim());
  if (tokens.includes("*")) return true;
  return tokens.some((token) => {
    const normalized = token.startsWith("W/") ? token.slice(2).trim() : token;
    return normalized === etag;
  });
}

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET(
  request: Request,
  context: ImageRouteContext,
): Promise<Response> {
  const { productId } = await context.params;
  const image = await loadDeliverableImageBytes(createStorage(), productId);
  if (!image) return notFound();

  const etag = `"${image.sha256}"`;
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      "content-type": image.mediaType,
      "content-length": String(image.bytes.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      etag,
    },
  });
}
