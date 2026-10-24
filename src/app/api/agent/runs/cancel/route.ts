import { z } from "zod";
import { cancelAgentRun } from "@/server/agent-manager";
import { readGuardedMutation } from "@/server/mutation-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cancelSchema = z.strictObject({
  runId: z.uuid(),
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

/**
 * Cooperative cancellation. The run keeps its paid lock until the worker is
 * proven gone, so a Stop click never unlocks a live paid operation; a worker
 * that ignores the cancel is marked `hung` by the supervisor watchdog and
 * cleaned up by the recovery phase.
 */
export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: cancelSchema });
  if (!guarded.ok) return guarded.response;

  const result = cancelAgentRun({ runId: guarded.data.runId });
  switch (result.status) {
    case "cancelling":
      return Response.json(
        { ok: true, runId: result.runId },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    case "run-hung":
      return failure(
        409,
        "run-hung",
        "This run is past its cancel grace period and can only be stopped by forced cleanup.",
      );
    case "run-mismatch":
      return failure(
        409,
        "run-mismatch",
        "A different agent run is active. Refresh the status before cancelling.",
        { activeRunId: result.activeRunId },
      );
    case "no-active-run":
      return failure(
        409,
        "no-active-run",
        "No agent run is active in this server process.",
      );
  }
}
