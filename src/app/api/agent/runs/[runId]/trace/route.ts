import { z } from "zod";
import {
  AGENT_TRACE_VERSION,
  type AgentTracePayload,
} from "@/lib/agent-trace";
import {
  AgentRunCorruptionError,
  listAgentRuns,
} from "@/server/agent-runs";
import { loadAgentTraceView } from "@/server/agent-trace";
import { createStorage, StorageCorruptionError } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TraceRouteContext {
  readonly params: Promise<{ readonly runId: string }>;
}

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

/**
 * Read-only persisted trace for one run. This is the history counterpart to
 * the SSE stream: selecting an older run can load its bounded events even
 * while the live stream is reconnecting.
 */
export async function GET(
  _request: Request,
  context: TraceRouteContext,
): Promise<Response> {
  const { runId } = await context.params;
  if (!z.uuid().safeParse(runId).success) {
    return failure(
      400,
      "invalid-run-id",
      "The agent run ID must be a UUID.",
    );
  }

  let storage: ReturnType<typeof createStorage>;
  try {
    storage = createStorage();
  } catch {
    return failure(
      500,
      "storage-unavailable",
      "Agent storage is unavailable; no trace was read.",
    );
  }

  try {
    // Match the SSE trace selection rule: only runs inside the bounded
    // newest-first history window are served. A future windowing change must
    // update both paths together.
    const listed = await listAgentRuns(storage);
    const run = listed.runs.find((entry) => entry.runId === runId);
    if (!run) {
      return failure(
        404,
        "run-not-found",
        "The selected agent run is not in saved history.",
      );
    }
    const trace = await loadAgentTraceView(storage, runId);
    const payload: AgentTracePayload = {
      version: AGENT_TRACE_VERSION,
      runId,
      events: trace.events,
      truncated: trace.truncated,
      reset: true,
    };
    return Response.json(payload, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (
      error instanceof AgentRunCorruptionError ||
      error instanceof StorageCorruptionError
    ) {
      return failure(
        500,
        "trace-unreadable",
        "The selected run or its saved trace is unreadable.",
      );
    }
    return failure(
      500,
      "trace-unavailable",
      "The selected trace is unavailable.",
    );
  }
}
