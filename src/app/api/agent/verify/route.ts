import { z } from "zod";
import { verifyAgentModel } from "@/server/agent-verification";
import { AgentCompatibilityError } from "@/server/agent-compatibility";
import { AgentRunCorruptionError } from "@/server/agent-runs";
import { CredentialError } from "@/server/credentials";
import { ModelSettingsCorruptionError } from "@/server/model-settings";
import { readGuardedMutation } from "@/server/mutation-guard";
import { StorageCorruptionError } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The browser action sends `confirmCost: true` only after the user checks the
 * separate cost warning. The fixed job limits are applied server-side; the
 * client cannot request larger limits or a different task.
 */
const verifySchema = z.strictObject({
  confirmCost: z.literal(true),
});

function failure(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: { code, message }, ...extra },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: verifySchema });
  if (!guarded.ok) return guarded.response;

  let result;
  try {
    result = await verifyAgentModel();
  } catch (error) {
    if (error instanceof CredentialError) {
      return failure(
        409,
        "key-required",
        "The stored OpenRouter key is unreadable. Enter and validate it again.",
      );
    }
    if (
      error instanceof AgentRunCorruptionError ||
      error instanceof AgentCompatibilityError ||
      error instanceof ModelSettingsCorruptionError ||
      error instanceof StorageCorruptionError
    ) {
      return failure(
        500,
        "state-unreadable",
        "Saved agent, model, or compatibility state is unreadable. No paid request was made.",
      );
    }
    return failure(
      500,
      "state-error",
      "The browser-model verification could not be started safely. No paid request was made.",
    );
  }

  switch (result.status) {
    case "started":
      return Response.json(
        { ok: true, run: result.run },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    case "run-active":
      return failure(
        409,
        "run-active",
        "An agent run is already active. Wait for it to finish before verifying the model.",
        { runId: result.runId },
      );
    case "key-required":
      return failure(
        409,
        "key-required",
        "Enter and validate an OpenRouter API key in Setup before verifying the browser model.",
      );
    case "verification-required":
      // The supervisor never returns this for a verification run; keep the
      // switch exhaustive without pretending a paid job started.
      return failure(
        409,
        "verification-required",
        "The verification run was refused by the agent gate.",
        { reason: result.reason },
      );
    case "paid-operation-active":
      return failure(
        409,
        "paid-operation-active",
        "Another paid operation holds the shared lock. No verification was started.",
      );
    case "app-unavailable":
      return failure(503, "app-unavailable", result.message);
    case "worker-unavailable":
      return failure(500, "worker-unavailable", result.message);
    case "lock-error":
      return failure(
        500,
        "lock-error",
        "The shared paid lock could not be acquired safely. No verification was started.",
      );
    case "invalid-request":
      return failure(400, "invalid-request", result.message);
    case "failed":
      return failure(500, "worker-failed", result.message, { run: result.run });
  }
}
