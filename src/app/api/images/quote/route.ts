import { z } from "zod";
import { getKeyStatus, loadOpenRouterKey } from "@/server/credentials";
import {
  ImageQuoteError,
  prepareImageQuote,
} from "@/server/image-quote";
import { readGuardedMutation } from "@/server/mutation-guard";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const quoteSchema = z.strictObject({
  selectedIds: z.array(z.string().min(1).max(16)).max(24).optional(),
  intent: z.enum(["resume", "regenerate"]).optional(),
});

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const guarded = await readGuardedMutation(request, { schema: quoteSchema });
  if (!guarded.ok) return guarded.response;

  let keyAvailable: boolean;
  let apiKey: string | undefined;
  try {
    keyAvailable = (await getKeyStatus(undefined, { sweepTemps: false })).keyAvailable;
    apiKey = await loadOpenRouterKey();
  } catch {
    return failure(409, "key-required", "The stored key is unreadable.");
  }
  if (!keyAvailable || !apiKey) {
    return failure(
      409,
      "key-required",
      "Enter and validate an OpenRouter API key before quoting a resume.",
    );
  }

  try {
    const quote = await prepareImageQuote({
      storage: createStorage(),
      apiKey,
      selectedIds: guarded.data.selectedIds,
      intent: guarded.data.intent,
    });
    return Response.json(
      {
        ok: true,
        quote: {
          targets: quote.targets,
          imageCount: quote.imageCount,
          unitPriceUsd: quote.unitPriceUsd,
          baseUsd: quote.baseUsd,
          worstCaseUsd: quote.worstCaseUsd,
          startingBalanceBaseUsd: quote.startingBalanceBaseUsd,
          startingBalanceWorstCaseUsd: quote.startingBalanceWorstCaseUsd,
          perRequestFloorUsd: quote.perRequestFloorUsd,
          providerSlug: quote.providerSlug,
          providerOnly: quote.providerOnly,
          fingerprint: quote.fingerprint,
        },
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ImageQuoteError) {
      return failure(
        error.code === "unavailable" ? 503 : 409,
        error.code,
        "The quote cannot be verified right now. No paid request was made.",
      );
    }
    return failure(500, "quote-failed", "The quote could not be prepared.");
  }
}
