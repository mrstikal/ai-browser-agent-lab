import type { AgentRunRecord } from "@/server/agent-runs";
import { presetUiEvidenceProblem } from "./agent-run-display";

/**
 * Client-safe history summary. The full run record stays server-side; this
 * bounded projection intentionally excludes task text, output, errors, worker
 * identity, and the form baseline so history payloads stay small and do not
 * duplicate sensitive or bulky fields.
 */
export interface AgentRunSummary {
  readonly runId: AgentRunRecord["runId"];
  readonly kind: AgentRunRecord["kind"];
  readonly presetId: AgentRunRecord["presetId"];
  readonly modelId: AgentRunRecord["modelId"];
  readonly status: AgentRunRecord["status"];
  readonly stopReason: AgentRunRecord["stopReason"];
  readonly startedAt: AgentRunRecord["startedAt"];
  readonly endedAt: AgentRunRecord["endedAt"];
  readonly durationMs: AgentRunRecord["durationMs"];
  readonly steps: AgentRunRecord["steps"];
  readonly usage: AgentRunRecord["usage"];
  readonly evaluation: AgentRunRecord["evaluation"];
  readonly uiEvidence: AgentRunRecord["uiEvidence"];
  /** Bounded page-evidence verdict; avoids exposing the origin/final URL. */
  readonly pageEvidence: "observed" | "unverified";
  readonly vision: AgentRunRecord["vision"];
  readonly uiMode: AgentRunRecord["uiMode"];
  /** Bounded failure context; the full record error stays server-side. */
  readonly errorSummary: string | null;
}

/**
 * Mirrors `AGENT_RUN_LIST_LIMIT`. History is a bounded window over persisted
 * runs, not an unbounded archive.
 */
export const AGENT_HISTORY_LIMIT = 50;

/** Keeps one history row readable without shipping a full worker error. */
export const AGENT_HISTORY_ERROR_SUMMARY_MAX_CHARS = 240;

function summarizeError(error: string | null): string | null {
  if (error === null) return null;
  const trimmed = error.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= AGENT_HISTORY_ERROR_SUMMARY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, AGENT_HISTORY_ERROR_SUMMARY_MAX_CHARS - 1)}…`;
}

export function toAgentRunSummary(run: AgentRunRecord): AgentRunSummary {
  return {
    runId: run.runId,
    kind: run.kind,
    presetId: run.presetId,
    modelId: run.modelId,
    status: run.status,
    stopReason: run.stopReason,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    steps: run.steps,
    usage: run.usage,
    evaluation: run.evaluation,
    uiEvidence: run.uiEvidence,
    pageEvidence:
      presetUiEvidenceProblem(run) === null ? "observed" : "unverified",
    vision: run.vision,
    uiMode: run.uiMode,
    errorSummary: summarizeError(run.error),
  };
}

export function sortAgentRunSummaries(
  runs: readonly AgentRunSummary[],
): AgentRunSummary[] {
  return [...runs].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      right.runId.localeCompare(left.runId),
  );
}

/** Newest first and capped, matching the persisted list contract. */
export function buildAgentHistory(
  runs: readonly AgentRunRecord[],
): AgentRunSummary[] {
  return sortAgentRunSummaries(runs.map(toAgentRunSummary)).slice(
    0,
    AGENT_HISTORY_LIMIT,
  );
}

/** Insert or replace one run without waiting for the next status snapshot. */
export function mergeAgentRunSummary(
  history: readonly AgentRunSummary[],
  run: AgentRunRecord,
): AgentRunSummary[] {
  const summary = toAgentRunSummary(run);
  return sortAgentRunSummaries([
    summary,
    ...history.filter((entry) => entry.runId !== summary.runId),
  ]).slice(0, AGENT_HISTORY_LIMIT);
}
