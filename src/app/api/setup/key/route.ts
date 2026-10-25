import { z } from "zod";
import {
  CredentialError,
  deleteOpenRouterKey,
  setOpenRouterKey,
} from "@/server/credentials";
import { readGuardedMutation } from "@/server/mutation-guard";
import {
  OpenRouterConfigError,
  validateOpenRouterKey,
} from "@/server/openrouter";
import {
  PaidOperationActiveError,
  PaidOperationError,
} from "@/server/paid-operation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const keySchema = z.strictObject({
  key: z.string().min(1).max(512),
  remember: z.boolean(),
});

const deleteSchema = z.strictObject({});

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: keySchema });
  if (!guarded.ok) return guarded.response;

  let validation;
  try {
    validation = await validateOpenRouterKey(guarded.data.key);
  } catch (error) {
    if (error instanceof OpenRouterConfigError) {
      return failure(
        500,
        "server-misconfigured",
        "The OpenRouter base URL is not configured safely.",
      );
    }
    return failure(422, "invalid-key", "The API key format is not acceptable.");
  }

  if (validation.status === "invalid") {
    return failure(
      422,
      "invalid-key",
      "OpenRouter rejected this key. Check the key and try again.",
    );
  }
  if (validation.status !== "valid") {
    return failure(
      503,
      "key-validation-unavailable",
      "The key could not be validated right now (network, timeout, or provider error). Nothing was stored.",
    );
  }

  try {
    const status = await setOpenRouterKey(guarded.data.key, {
      remember: guarded.data.remember,
    });
    return Response.json(
      {
        keyAvailable: status.keyAvailable,
        source: status.source,
        // Derived locally from the non-billable validation; the provider's
        // metadata fields and masked label are never forwarded.
        keyPermitsInference: !validation.managementOnly,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PaidOperationActiveError || error instanceof PaidOperationError) {
      return failure(
        409,
        "paid-operation-active",
        "A paid operation is active. Wait for it to finish before changing the key.",
      );
    }
    if (error instanceof CredentialError) {
      return failure(
        500,
        "credential-store-error",
        "The key could not be stored safely. Nothing was changed.",
      );
    }
    throw error;
  }
}

export async function DELETE(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: deleteSchema });
  if (!guarded.ok) return guarded.response;

  try {
    const status = await deleteOpenRouterKey();
    return Response.json(
      { keyAvailable: status.keyAvailable, source: status.source },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PaidOperationActiveError || error instanceof PaidOperationError) {
      return failure(
        409,
        "paid-operation-active",
        "A paid operation is active. Wait for it to finish before deleting the key.",
      );
    }
    throw error;
  }
}
