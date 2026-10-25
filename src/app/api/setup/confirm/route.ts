import { z } from "zod";
import { getKeyStatus, loadOpenRouterKey } from "@/server/credentials";
import {
  ImageQuoteError,
  prepareImageQuote,
  type ImageQuote,
} from "@/server/image-quote";
import { readGuardedMutation } from "@/server/mutation-guard";
import {
  assertNoActivePaidOperation,
  PaidOperationActiveError,
} from "@/server/paid-operation";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const confirmSchema = z.strictObject({
  confirm: z.literal(true),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function safeQuote(quote: ImageQuote) {
  return {
    targets: quote.targets,
    imageCount: quote.imageCount,
    attemptsPerImage: quote.attemptsPerImage,
    selection: quote.selection,
    providerSlug: quote.providerSlug,
    providerTag: quote.providerTag,
    providerOnly: quote.providerOnly,
    unitPriceUsd: quote.unitPriceUsd,
    baseUsd: quote.baseUsd,
    worstCaseUsd: quote.worstCaseUsd,
    startingBalanceBaseUsd: quote.startingBalanceBaseUsd,
    startingBalanceWorstCaseUsd: quote.startingBalanceWorstCaseUsd,
    perRequestFloorUsd: quote.perRequestFloorUsd,
    fingerprint: quote.fingerprint,
  };
}

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: confirmSchema });
  if (!guarded.ok) return guarded.response;

  try {
    assertNoActivePaidOperation();
  } catch (error) {
    if (error instanceof PaidOperationActiveError) {
      return failure(
        409,
        "paid-operation-active",
        "A paid operation is active. Wait for it to finish before confirming a new estimate.",
      );
    }
    throw error;
  }

  let keyAvailable: boolean;
  let apiKey: string | undefined;
  try {
    keyAvailable = (await getKeyStatus(undefined, { sweepTemps: false })).keyAvailable;
    apiKey = await loadOpenRouterKey();
  } catch {
    return failure(
      409,
      "key-required",
      "The stored key is unreadable. Enter and validate the key again.",
    );
  }
  if (!keyAvailable || !apiKey) {
    return failure(
      409,
      "key-required",
      "Enter and validate an OpenRouter API key before confirming a quote.",
    );
  }

  let quote: ImageQuote;
  try {
    quote = await prepareImageQuote({
      storage: createStorage(),
      apiKey,
    });
  } catch (error) {
    if (error instanceof ImageQuoteError) {
      if (error.code === "unavailable") {
        return failure(
          503,
          error.code,
          "The price check is temporarily unavailable. No paid request was made.",
        );
      }
      return failure(
        409,
        error.code,
        "The quote is not current or cannot be verified. No paid request was made.",
      );
    }
    return failure(500, "quote-failed", "The quote could not be prepared.");
  }

  if (quote.fingerprint !== guarded.data.fingerprint) {
    return Response.json(
      {
        error: {
          code: "quote-changed",
          message:
            "The estimate changed since it was displayed. Review the new quote before confirming.",
        },
        quote: safeQuote(quote),
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    {
      ok: true,
      started: false,
      acceptedFingerprint: quote.fingerprint,
      quote: safeQuote(quote),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
