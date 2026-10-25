import type { AgentGate } from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";
import type { AgentRunSummary } from "./agent-history";
import type { AgentRunStatus } from "./agent-ipc";
import { AGENT_UI_MODE_LABELS, type AgentUiMode } from "./agent-ui-mode";
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
          "Runs without a deterministic evaluation are not automatically passed. Execution status is reported separately from task success.",
      };
  }
}

/**
 * Honest one-line outcome for a persisted history row. A preset task uses the
 * overall result, so a cancelled or limit-bound run can never be summarized as
 * a full pass; verification and custom runs keep their own semantics.
 */
export function describeHistoryResult(
  run: Pick<
    AgentRunSummary,
    "kind" | "presetId" | "status" | "stopReason" | "evaluation" | "uiEvidence"
  >,
): TaskResultDescription {
  if (run.kind === "task" && run.presetId !== null) {
    return describeOverallTaskResult(run);
  }
  if (run.kind === "verification") {
    if (run.evaluation.status === "failed") {
      return {
        label: "Verification failed",
        tone: "danger",
        detail:
          run.evaluation.reason ??
          "The fixed browser verification did not pass.",
      };
    }
    if (run.evaluation.status === "passed") {
      if (run.status === "completed" && run.stopReason === "completed") {
        return {
          label: "Verification answer passed",
          tone: "success",
          detail:
            run.evaluation.reason ??
            "The model read the Shop heading from the running app; check the verification panel for the current stamp.",
        };
      }
      return {
        label: "Verification answer passed; execution not completed",
        tone: "warning",
        detail:
          "The heading answer matched, but the run did not complete cleanly and no verification stamp was written from it.",
      };
    }
    if (
      run.status === "running" ||
      run.status === "cancelling" ||
      run.status === "hung"
    ) {
      return {
        label: "Verification pending",
        tone: "neutral",
        detail: "The fixed heading check runs once the execution settles.",
      };
    }
    return {
      label: "Not evaluated",
      tone: "neutral",
      detail:
        "No verification evaluation was recorded. Execution status is reported separately.",
    };
  }
  return {
    label: "Not evaluated",
    tone: "neutral",
    detail:
      "Custom tasks are not automatically evaluated. Execution status is reported separately.",
  };
}

export interface OverallTaskResult extends RunLabel {
  readonly detail: string;
  /** True only for a completed execution, a passed result, and observed UI. */
  readonly fullPass: boolean;
}

/** The overall block is only meaningful for a predefined catalog task. */
export function shouldShowOverallTaskResult(
  run: Pick<AgentRunRecord, "kind" | "presetId">,
): boolean {
  return run.kind === "task" && run.presetId !== null;
}

/**
 * Overall outcome for a predefined task. A matching business answer is not a
 * full pass unless the execution completed and a browser tool event was
 * observed; custom tasks remain not evaluated.
 */
export function describeOverallTaskResult(
  run: Pick<
    AgentRunRecord,
    "kind" | "presetId" | "status" | "stopReason" | "evaluation" | "uiEvidence"
  >,
): OverallTaskResult {
  if (!shouldShowOverallTaskResult(run)) {
    return {
      label: "Not evaluated",
      tone: "neutral",
      detail:
        "No deterministic evaluation is available. Execution status and UI evidence are reported separately.",
      fullPass: false,
    };
  }
  if (run.evaluation.status === "not_evaluated") {
    if (
      run.status === "running" ||
      run.status === "cancelling" ||
      run.status === "hung"
    ) {
      return {
        label: "Evaluation pending",
        tone: "neutral",
        detail:
          "The deterministic evaluator runs once the execution settles.",
        fullPass: false,
      };
    }
    return {
      label: "Not evaluated",
      tone: "neutral",
      detail:
        "No deterministic evaluation is available. Execution status and UI evidence are reported separately.",
      fullPass: false,
    };
  }
  if (run.evaluation.status === "failed") {
    return {
      label: "Task failed",
      tone: "danger",
      detail:
        run.evaluation.reason ?? "The independent evaluator failed this task.",
      fullPass: false,
    };
  }
  if (run.status !== "completed" || run.stopReason !== "completed") {
    return {
      label: "Business result passed; execution not completed",
      tone: "warning",
      detail:
        "The answer matched, but the run did not complete cleanly. This is not a full pass.",
      fullPass: false,
    };
  }
  if (run.uiEvidence !== "observed") {
    return {
      label: "Business result passed; UI unverified",
      tone: "warning",
      detail:
        "The answer matched, but no successful browser JavaScript tool event was observed. This is not a full pass.",
      fullPass: false,
    };
  }
  return {
    label: "Full task pass",
    tone: "success",
    detail:
      "The execution completed, the business result matched, and a successful browser JavaScript tool event was observed.",
    fullPass: true,
  };
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

/** Deterministic UTC label for persisted start/end timestamps. */
export function formatRunTimestamp(at: string | null): string {
  if (at === null) return "not finished";
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return at;
  return `${new Date(parsed).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Captured mode or an explicit "not captured" label, never a guess. */
export function describeUiMode(mode: AgentUiMode | null): string {
  return mode === null ? "not captured" : AGENT_UI_MODE_LABELS[mode];
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
