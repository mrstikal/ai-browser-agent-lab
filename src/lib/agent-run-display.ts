import type { AgentGate } from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";
import type { AgentRunStatus } from "./agent-ipc";
import { formatUsd } from "./format";

/**
 * Client-safe presentation helpers. They keep execution status separate from
 * task success: a `completed` run only means the worker delivered a terminal
 * result, and custom tasks are never automatically passed.
 */

export type RunTone = "neutral" | "success" | "warning" | "danger";

export interface RunLabel {
  readonly label: string;
  readonly tone: RunTone;
}

const STOP_REASON_SHORT: Record<AgentRunStatus, string> = {
  completed: "SDK completed",
  max_steps: "step limit",
  timeout: "time limit",
  cancelled: "cancelled",
  cost_limit: "soft cost limit",
  context_limit: "context limit",
  incomplete: "incomplete SDK run",
  error: "SDK error",
};

const STOP_REASON_SENTENCE: Record<AgentRunStatus, string> = {
  completed: "The SDK completed the run.",
  max_steps: "The step limit ended the run.",
  timeout: "The time limit ended the run.",
  cancelled: "The run was cancelled.",
  cost_limit: "The soft cost limit ended the run.",
  context_limit: "The context limit ended the run.",
  incomplete: "The SDK reported an incomplete run.",
  error: "The SDK reported an error.",
};

export function describeStopReason(stopReason: AgentRunStatus | null): string {
  if (stopReason === null) return "No SDK stop reason was recorded.";
  return STOP_REASON_SENTENCE[stopReason];
}

export function describeExecutionStatus(
  run: Pick<AgentRunRecord, "status" | "stopReason">,
): RunLabel {
  switch (run.status) {
    case "running":
      return { label: "Running", tone: "neutral" };
    case "cancelling":
      return { label: "Cancelling", tone: "warning" };
    case "hung":
      return { label: "Hung — cleanup required", tone: "danger" };
    case "interrupted":
      return { label: "Interrupted by restart", tone: "warning" };
    case "failed":
      return { label: "Execution failed", tone: "danger" };
    case "completed":
      if (run.stopReason === "completed") {
        return { label: "Execution completed", tone: "neutral" };
      }
      return {
        label: `Execution stopped (${
          run.stopReason === null
            ? "no stop reason"
            : STOP_REASON_SHORT[run.stopReason]
        })`,
        tone: "warning",
      };
  }
}

export interface TaskResultDescription extends RunLabel {
  readonly detail: string;
}

export function describeTaskResult(
  evaluation: Pick<AgentRunRecord["evaluation"], "status" | "reason">,
): TaskResultDescription {
  switch (evaluation.status) {
    case "passed":
      return {
        label: "Task passed",
        tone: "success",
        detail:
          evaluation.reason ??
          "The independent evaluator passed this task.",
      };
    case "failed":
      return {
        label: "Task failed",
        tone: "danger",
        detail:
          evaluation.reason ??
          "The independent evaluator failed this task.",
      };
    case "not_evaluated":
      return {
        label: "Not evaluated",
        tone: "neutral",
        detail:
          "Custom tasks are not automatically passed. Execution status is reported separately from task success.",
      };
  }
}

export function formatEstimatedCost(
  usage: AgentRunRecord["usage"],
): string {
  if (!usage || usage.estimatedCostUsd === null) return "unknown";
  return formatUsd(usage.estimatedCostUsd);
}

export function formatTokens(usage: AgentRunRecord["usage"]): string {
  if (!usage || usage.totalTokens === null) return "unknown";
  return `${usage.totalTokens} tokens`;
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "unknown";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

export interface GateBlocker {
  readonly title: string;
  readonly detail: string;
}

export function describeGateBlocker(gate: AgentGate): GateBlocker | null {
  if (!gate.keyAvailable) {
    return {
      title: "OpenRouter key required",
      detail:
        "Add and validate a key in Setup before starting a live task.",
    };
  }
  switch (gate.reason) {
    case "verified":
      return null;
    case "key-required":
      return {
        title: "OpenRouter key required",
        detail:
          "Add and validate a key in Setup before starting a live task.",
      };
    case "sdk-unavailable":
      return {
        title: "Browser SDK unavailable",
        detail:
          "The installed @browser_use/pi package metadata is missing. Run npm install.",
      };
    case "verification-required":
      return {
        title: "Verification required",
        detail:
          "Run Verify Agent Model above so the current model, SDK version, and app origin are stamped.",
      };
    case "model-mismatch":
      return {
        title: "A different browser model is stamped",
        detail:
          "The saved verification belongs to another model. Run Verify Agent Model again.",
      };
    case "origin-mismatch":
      return {
        title: "A different app origin is stamped",
        detail:
          "The saved verification belongs to another origin. Run Verify Agent Model again from this origin.",
      };
    case "sdk-mismatch":
      return {
        title: "A different SDK version is stamped",
        detail:
          "The installed browser SDK changed. Run Verify Agent Model again.",
      };
  }
}
