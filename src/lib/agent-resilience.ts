import type { AgentRunSummary } from "./agent-history";
import {
  AGENT_TASK_PRESETS,
  type AgentPresetTaskId,
} from "./agent-tasks";
import { describeOverallTaskResult } from "./agent-run-display";
import { AGENT_UI_MODES, type AgentUiMode } from "./agent-ui-mode";

/** Below this sample size the view is explicitly descriptive, not reliable. */
export const AGENT_RESILIENCE_MIN_SAMPLE = 5;

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);

export interface ResilienceModeStats {
  readonly mode: AgentUiMode;
  readonly fullPasses: number;
  readonly businessPasses: number;
  readonly sampleSize: number;
}

export interface ResilienceGroup {
  readonly modelId: string;
  readonly presetId: AgentPresetTaskId;
  readonly modes: Readonly<Record<AgentUiMode, ResilienceModeStats>>;
  /** Both modes have at least one terminal stored run. */
  readonly comparable: boolean;
}

export interface ResilienceExclusions {
  readonly noMode: number;
  readonly active: number;
  readonly nonPreset: number;
}

export interface ResilienceComparison {
  readonly groups: readonly ResilienceGroup[];
  readonly exclusions: ResilienceExclusions;
  readonly windowSize: number;
}

function emptyStats(mode: AgentUiMode): ResilienceModeStats {
  return {
    mode,
    fullPasses: 0,
    businessPasses: 0,
    sampleSize: 0,
  };
}

function addRun(
  stats: ResilienceModeStats,
  fullPass: boolean,
  businessPass: boolean,
): ResilienceModeStats {
  return {
    mode: stats.mode,
    fullPasses: stats.fullPasses + (fullPass ? 1 : 0),
    businessPasses: stats.businessPasses + (businessPass ? 1 : 0),
    sampleSize: stats.sampleSize + 1,
  };
}

/**
 * Descriptive comparison of stored predefined-task outcomes. Success is the
 * strict full pass (completed execution + independent evaluation + observed
 * UI), while `businessPasses` separately shows evaluator matches. Active runs,
 * custom/verification runs, and runs without a captured mode are excluded.
 */
export function buildAgentResilienceComparison(
  runs: readonly AgentRunSummary[],
): ResilienceComparison {
  const groups = new Map<
    string,
    {
      modelId: string;
      presetId: AgentPresetTaskId;
      modes: Record<AgentUiMode, ResilienceModeStats>;
    }
  >();
  const exclusions = { noMode: 0, active: 0, nonPreset: 0 };

  for (const run of runs) {
    if (run.kind !== "task" || run.presetId === null) {
      exclusions.nonPreset += 1;
      continue;
    }
    if (run.uiMode === null) {
      exclusions.noMode += 1;
      continue;
    }
    if (!TERMINAL_STATUSES.has(run.status)) {
      exclusions.active += 1;
      continue;
    }

    const key = `${run.modelId}\u0000${run.presetId}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        modelId: run.modelId,
        presetId: run.presetId,
        modes: {
          classic: emptyStats("classic"),
          alternate: emptyStats("alternate"),
        },
      };
      groups.set(key, group);
    }
    group.modes[run.uiMode] = addRun(
      group.modes[run.uiMode],
      describeOverallTaskResult(run).fullPass,
      run.evaluation.status === "passed",
    );
  }

  const presetOrder = new Map(
    AGENT_TASK_PRESETS.map((preset, index) => [preset.id, index]),
  );
  const sorted = [...groups.values()].sort(
    (left, right) =>
      left.modelId.localeCompare(right.modelId) ||
      (presetOrder.get(left.presetId) ?? 0) -
        (presetOrder.get(right.presetId) ?? 0),
  );

  return {
    groups: sorted.map((group) => ({
      ...group,
      modes: {
        classic: group.modes.classic,
        alternate: group.modes.alternate,
      },
      comparable:
        group.modes.classic.sampleSize > 0 &&
        group.modes.alternate.sampleSize > 0,
    })),
    exclusions,
    windowSize: runs.length,
  };
}

export interface ResilienceSampleDescription {
  readonly label: string;
  readonly detail: string;
  /** False for every count in this view; no significance test is performed. */
  readonly statisticallyReliable: false;
}

export function describeResilienceSample(
  sampleSize: number,
): ResilienceSampleDescription {
  if (sampleSize <= 0) {
    return {
      label: "No sample",
      detail: "No terminal stored runs match this model, task, and mode.",
      statisticallyReliable: false,
    };
  }
  if (sampleSize === 1) {
    return {
      label: "Single run",
      detail:
        "A single run is anecdotal and is not statistically reliable evidence.",
      statisticallyReliable: false,
    };
  }
  if (sampleSize < AGENT_RESILIENCE_MIN_SAMPLE) {
    return {
      label: "Small sample",
      detail: `n=${sampleSize} is descriptive only; this is not statistically reliable evidence.`,
      statisticallyReliable: false,
    };
  }
  return {
    label: "Descriptive counts",
    detail:
      "Counts only; no statistical significance test or confidence interval is computed.",
    statisticallyReliable: false,
  };
}

/** Rows are emitted in the fixed Classic, Alternate order. */
export function resilienceModes(): readonly AgentUiMode[] {
  return AGENT_UI_MODES;
}
