import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentUiModeSchema } from "@/lib/agent-ui-mode";
import { readGuardedMutation } from "@/server/mutation-guard";
import {
  beginPaidOperation,
  endPaidOperation,
  PaidOperationActiveError,
} from "@/server/paid-operation";
import { createStorage } from "@/server/storage";
import { saveUiMode } from "@/server/ui-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const modeSchema = z.strictObject({
  mode: agentUiModeSchema,
});

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: modeSchema });
  if (!guarded.ok) return guarded.response;

  // Reserve the same exclusive slot as a paid operation. The check and write
  // must be one critical section; otherwise a run could begin after the check,
  // capture the old mode, and then the write could land after that capture.
  const ownerId = `ui-mode:${randomUUID()}`;
  try {
    beginPaidOperation(ownerId, "ui-mode");
  } catch (error) {
    if (error instanceof PaidOperationActiveError) {
      return failure(
        409,
        "paid-operation-active",
        "The layout cannot change while an image batch, agent run, or another layout change is active.",
      );
    }
    throw error;
  }

  try {
    const settings = await saveUiMode(createStorage(), guarded.data.mode);
    return Response.json(
      { mode: settings.mode, updatedAt: settings.updatedAt },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return failure(
      500,
      "mode-save-failed",
      "The layout mode could not be saved. Nothing else changed.",
    );
  } finally {
    endPaidOperation(ownerId);
  }
}
