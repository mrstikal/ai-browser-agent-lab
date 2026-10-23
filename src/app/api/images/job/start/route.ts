import { z } from "zod";
import { imageModelSettingsSchema } from "@/lib/schemas";
import { getKeyStatus, loadOpenRouterKey } from "@/server/credentials";
import { startImageJob } from "@/server/image-job";
import { startImageBatch } from "@/server/image-batch";
import { ImageStateCorruptionError } from "@/server/image-state";
import { readGuardedMutation } from "@/server/mutation-guard";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const startSchema = z.strictObject({
  confirm: z.literal(true),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  selection: imageModelSettingsSchema.optional(),
  selectedIds: z.array(z.string().min(1).max(16)).max(24).optional(),
});

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function quoteSummary(quote: {
  readonly imageCount: number;
  readonly unitPriceUsd: string;
  readonly baseUsd: string;
  readonly worstCaseUsd: string;
  readonly startingBalanceBaseUsd: string;
  readonly startingBalanceWorstCaseUsd: string;
  readonly providerSlug: string;
  readonly providerOnly: readonly string[];
  readonly fingerprint: string;
}) {
  return {
    imageCount: quote.imageCount,
    unitPriceUsd: quote.unitPriceUsd,
    baseUsd: quote.baseUsd,
    worstCaseUsd: quote.worstCaseUsd,
    startingBalanceBaseUsd: quote.startingBalanceBaseUsd,
    startingBalanceWorstCaseUsd: quote.startingBalanceWorstCaseUsd,
    providerSlug: quote.providerSlug,
    providerOnly: quote.providerOnly,
    fingerprint: quote.fingerprint,
  };
}

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: startSchema });
  if (!guarded.ok) return guarded.response;

  let keyAvailable: boolean;
  let apiKey: string | undefined;
  try {
    keyAvailable = (await getKeyStatus()).keyAvailable;
    apiKey = await loadOpenRouterKey();
  } catch {
    return failure(409, "key-required", "The stored key is unreadable. Validate it again.");
  }
  if (!keyAvailable || !apiKey) {
    return failure(
      409,
      "key-required",
      "Enter and validate an OpenRouter API key before starting a batch.",
    );
  }

  let result;
  try {
    result = await startImageJob({
      storage: createStorage(),
      apiKey,
      fingerprint: guarded.data.fingerprint,
      selection: guarded.data.selection,
      selectedIds: guarded.data.selectedIds,
    });
  } catch (error) {
    if (error instanceof ImageStateCorruptionError) {
      return failure(
        500,
        "state-corrupt",
        "Saved image-job state is unreadable. Inspect data/image-job.json before starting.",
      );
    }
    return failure(
      500,
      "state-error",
      "The job state could not be updated safely. No paid request was made.",
    );
  }

  switch (result.status) {
    case "started": {
      // Fire-and-forget: the worker holds the admitted lock and persists all
      // progress. Duplicate starts join this controller instead of forking it.
      void startImageBatch({
        storage: createStorage(),
        jobId: result.job.jobId,
        apiKey,
      });
      return Response.json(
        { ok: true, existing: false, job: result.job },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }
    case "existing":
      return Response.json(
        { ok: true, existing: true, job: result.job },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    case "quote-changed":
      return Response.json(
        {
          error: {
            code: "quote-changed",
            message:
              "The accepted quote is no longer current. Review the new estimate before starting.",
          },
          quote: quoteSummary(result.quote),
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    case "job-active":
      return Response.json(
        {
          error: {
            code: "job-active",
            message:
              "An image job is already active or awaiting recovery. No second batch was admitted.",
          },
          job: result.job
            ? { jobId: result.job.jobId, status: result.job.status }
            : null,
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    case "paid-operation-active":
      return failure(
        409,
        "paid-operation-active",
        "Another paid operation holds the shared lock. No new batch was admitted.",
      );
    case "quote-rejected":
      return failure(
        409,
        result.code,
        "The quote cannot be verified or is no longer current. No paid request was made.",
      );
    case "unavailable":
      return failure(
        503,
        "unavailable",
        "The price check is temporarily unavailable. No paid request was made.",
      );
    case "lock-error":
      return failure(
        500,
        "lock-error",
        "The shared paid-job lock could not be acquired safely. No paid request was made.",
      );
  }
}
