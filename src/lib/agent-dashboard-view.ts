import type {
  AgentGate,
  AgentRecoveryStatus,
} from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";
import {
  buildAgentHistory,
  type AgentRunSummary,
} from "./agent-history";

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
  /** Newest-first, bounded summaries of persisted runs. */
  readonly history: readonly AgentRunSummary[];
  /** Last startup-recovery report, including manual-cleanup obligations. */
  readonly recovery: AgentRecoveryStatus | null;
}

export interface AgentStatusLike {
  readonly gate: AgentGate;
  readonly activeRunId: string | null;
  readonly runs: readonly AgentRunRecord[];
  readonly recovery?: AgentRecoveryStatus | null;
}

/**
 * Client-facing status response. Only the active and latest records travel in
 * full (the panels render their task/output/error); older runs are represented
 * by the bounded history summaries.
 */
export const AGENT_STATUS_VERSION = 1 as const;

export interface AgentStatusPayload {
  readonly version: typeof AGENT_STATUS_VERSION;
  readonly generatedAt: string;
  readonly view: AgentDashboardView;
  readonly corruptRuns: number;
}

export function buildAgentStatusPayload(
  snapshot: AgentStatusLike & { readonly corruptRuns: number },
  generatedAt: string = new Date().toISOString(),
): AgentStatusPayload {
  return {
    version: AGENT_STATUS_VERSION,
    generatedAt,
    view: pickAgentDashboardView(snapshot),
    corruptRuns: snapshot.corruptRuns,
  };
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
    history: buildAgentHistory(snapshot.runs),
    recovery: snapshot.recovery ?? null,
  };
}

export interface AgentTraceTarget {
  readonly runId: string;
}

/**
 * The trace follows an explicitly selected persisted run, otherwise the
 * current task run, and after it settles the latest task run. An unreadable
 * active record or a selected run outside the bounded history yields no trace
 * instead of silently showing a different run.
 */
export function selectTraceRun(
  view: AgentDashboardView,
  selectedRunId: string | null = null,
): AgentTraceTarget | null {
  if (selectedRunId !== null) {
    return view.history.some((run) => run.runId === selectedRunId)
      ? { runId: selectedRunId }
      : null;
  }
  if (view.activeRunId !== null) {
    if (view.activeRun === null) return null;
    return view.activeRun.kind === "task"
      ? { runId: view.activeRun.runId }
      : view.latestTask === null
        ? null
        : { runId: view.latestTask.runId };
  }
  return view.latestTask === null ? null : { runId: view.latestTask.runId };
}
