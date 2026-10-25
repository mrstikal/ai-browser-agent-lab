import { z } from "zod";
import {
  AGENT_WORKER_MAX_TASK_CHARS,
  agentRunLimitsSchema,
} from "@/lib/agent-ipc";
import { agentPresetTaskIdSchema } from "@/lib/agent-tasks";
import { AgentCompatibilityError } from "@/server/agent-compatibility";
import { startAgentRun } from "@/server/agent-manager";
import { startPresetTaskRun } from "@/server/agent-task-evaluator";
import { AgentRunCorruptionError } from "@/server/agent-runs";
import { CredentialError } from "@/server/credentials";
import { ModelSettingsCorruptionError } from "@/server/model-settings";
import { readGuardedMutation } from "@/server/mutation-guard";
import { StorageCorruptionError } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const limitsSchema = agentRunLimitsSchema.partial().optional();

/** Exactly one of `task` (custom) or `presetId` (preset Tasks 1-5). */
const startSchema = z.union([
  z.strictObject({
    task: z.string().trim().min(1).max(AGENT_WORKER_MAX_TASK_CHARS),
    limits: limitsSchema,
  }),
  z.strictObject({
    presetId: agentPresetTaskIdSchema,
    limits: limitsSchema,
  }),
]);

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
  const guarded = await readGuardedMutation(request, { schema: startSchema });
  if (!guarded.ok) return guarded.response;

  let result;
  try {
    result =
      "presetId" in guarded.data
        ? await startPresetTaskRun({
            presetId: guarded.data.presetId,
            limits: guarded.data.limits,
          })
        : await startAgentRun({
            kind: "task",
            task: guarded.data.task,
            limits: guarded.data.limits,
          });
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
      "The agent run could not be started safely. No paid request was made.",
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
        "An agent run is already active. Wait for it to finish before starting another.",
        { runId: result.runId },
      );
    case "key-required":
      return failure(
        409,
        "key-required",
        "Enter and validate an OpenRouter API key before starting a task.",
      );
    case "verification-required":
      return failure(
        409,
        "verification-required",
        "Verify the current browser model before starting arbitrary live tasks.",
        { reason: result.reason },
      );
    case "paid-operation-active":
      return failure(
        409,
        "paid-operation-active",
        "Another paid operation holds the shared lock. No task was started.",
      );
    case "app-unavailable":
      return failure(503, "app-unavailable", result.message);
    case "worker-unavailable":
      return failure(500, "worker-unavailable", result.message);
    case "lock-error":
      return failure(
        500,
        "lock-error",
        "The shared paid lock could not be acquired safely. No task was started.",
      );
    case "invalid-request":
      return failure(400, "invalid-request", result.message);
    case "failed":
      return failure(500, "worker-failed", result.message, { run: result.run });
  }
}
