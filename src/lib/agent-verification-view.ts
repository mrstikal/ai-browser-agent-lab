import type { AgentGate } from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";

/**
 * Minimal, serializable view shared by the server-rendered `/agent` page and
 * its client verification panel. Type-only server imports keep this module
 * safe for the client bundle.
 */
export interface AgentVerificationView {
  readonly gate: AgentGate;
  readonly activeRunId: string | null;
  readonly latestVerification: AgentRunRecord | null;
}

export interface AgentStatusLike {
  readonly gate: AgentGate;
  readonly activeRunId: string | null;
  readonly runs: readonly AgentRunRecord[];
}

export function pickAgentVerificationView(
  snapshot: AgentStatusLike,
): AgentVerificationView {
  return {
    gate: snapshot.gate,
    activeRunId: snapshot.activeRunId,
    latestVerification:
      snapshot.runs.find((run) => run.kind === "verification") ?? null,
  };
}
