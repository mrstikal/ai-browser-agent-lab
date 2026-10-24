import type { AgentGate } from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";

/**
 * Minimal, serializable dashboard view shared by the server-rendered `/agent`
 * page and its client panels. Type-only server imports keep this module safe
 * for the client bundle.
 */
export interface AgentDashboardView {
  readonly gate: AgentGate;
  readonly activeRunId: string | null;
  readonly activeRun: AgentRunRecord | null;
  readonly latestVerification: AgentRunRecord | null;
  readonly latestTask: AgentRunRecord | null;
}

export interface AgentStatusLike {
  readonly gate: AgentGate;
  readonly activeRunId: string | null;
  readonly runs: readonly AgentRunRecord[];
}

export function pickAgentDashboardView(
  snapshot: AgentStatusLike,
): AgentDashboardView {
  const activeRun =
    snapshot.activeRunId === null
      ? null
      : (snapshot.runs.find((run) => run.runId === snapshot.activeRunId) ??
        null);
  return {
    gate: snapshot.gate,
    activeRunId: snapshot.activeRunId,
    activeRun,
    latestVerification:
      snapshot.runs.find((run) => run.kind === "verification") ?? null,
    latestTask: snapshot.runs.find((run) => run.kind === "task") ?? null,
  };
}
