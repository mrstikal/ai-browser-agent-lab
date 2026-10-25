import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getActiveAgentRunId } from "@/server/agent-manager";
import { listActiveAgentRuns } from "@/server/agent-runs";
import { acquireLock, LockHeldError, type OwnerLock } from "@/server/lock";
import { readGuardedMutation } from "@/server/mutation-guard";
import {
  AGENT_RUN_LOCK_KIND,
  PAID_JOB_LOCK_SEGMENTS,
  SUBMISSIONS_RESET_LOCK_KIND,
} from "@/server/paid-lock";
import { createStorage, type Storage } from "@/server/storage";
import { resetSubmissions } from "@/server/submissions-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const resetSchema = z.strictObject({ confirm: z.literal(true) });

function failure(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const guarded = await readGuardedMutation(request, { schema: resetSchema });
  if (!guarded.ok) return guarded.response;

  let storage: Storage;
  let lock: OwnerLock;
  try {
    storage = createStorage();
    // Holding the same lock as agent start closes the check-then-delete race:
    // a worker cannot be between lock acquisition and its initial run-record
    // save while this reset is deleting submissions.
    lock = await acquireLock(storage, PAID_JOB_LOCK_SEGMENTS, {
      kind: SUBMISSIONS_RESET_LOCK_KIND,
      ownerId: randomUUID(),
      releaseOnExit: true,
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      const agentRun = error.owner.kind === AGENT_RUN_LOCK_KIND;
      return failure(
        409,
        agentRun ? "agent-run-active" : "paid-operation-active",
        agentRun
          ? "Form submissions cannot be reset while an agent run is active."
          : "Form submissions cannot be reset while another paid operation is active.",
      );
    }
    console.error(
      `[ai-browser-agent-lab] submissions reset lock failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return failure(
      500,
      "reset-failed",
      "The submissions could not be reset safely.",
    );
  }

  try {
    const holderRunId = getActiveAgentRunId(storage.root);
    const active = await listActiveAgentRuns(storage);
    if (holderRunId !== null || active.runs.length > 0) {
      return failure(
        409,
        "agent-run-active",
        "Form submissions cannot be reset while an agent run is active.",
      );
    }
    if (active.corrupt > 0) {
      return failure(
        500,
        "state-unreadable",
        `Agent run state is unreadable (${active.corrupt} corrupt record(s)), so the submissions reset was refused.`,
      );
    }
    const removed = await resetSubmissions(storage);
    return Response.json(
      { ok: true, removed },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error(
      `[ai-browser-agent-lab] submissions reset failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return failure(
      500,
      "reset-failed",
      "The submissions could not be reset.",
    );
  } finally {
    await lock.release().catch((error: unknown) => {
      console.error(
        `[ai-browser-agent-lab] submissions reset lock release failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
  }
}
