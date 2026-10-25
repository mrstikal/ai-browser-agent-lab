"use client";

import { useMemo, useState } from "react";
import { AGENT_HISTORY_LIMIT, type AgentRunSummary } from "@/lib/agent-history";
import type { AgentRunLimits } from "@/lib/agent-ipc";
import {
  buildAgentResilienceComparison,
  describeResilienceSample,
  resilienceModes,
} from "@/lib/agent-resilience";
import {
  AGENT_TASK_PRESETS,
  type AgentPresetTaskId,
  type AgentTaskStartRequest,
} from "@/lib/agent-tasks";
import {
  AGENT_UI_MODE_LABELS,
  type AgentUiMode,
} from "@/lib/agent-ui-mode";
import { describeGateBlocker } from "@/lib/agent-run-display";
import { formatUsd } from "@/lib/format";
import type { AgentGate } from "@/server/agent-manager";
import type {
  DashboardAction,
  TaskLimitsCaps,
} from "./agent-dashboard";

export interface ResiliencePanelProps {
  readonly runs: readonly AgentRunSummary[];
  readonly gate: AgentGate;
  readonly uiMode: AgentUiMode;
  readonly defaults: AgentRunLimits;
  readonly caps: TaskLimitsCaps;
  readonly runActive: boolean;
  readonly busy: DashboardAction | null;
  readonly onRun: (request: AgentTaskStartRequest) => Promise<boolean>;
}

const SELECT_CLASS =
  "mt-1 w-full rounded border border-slate-300 bg-white p-2 text-sm";

export function ResiliencePanel({
  runs,
  gate,
  uiMode,
  defaults,
  caps,
  runActive,
  busy,
  onRun,
}: ResiliencePanelProps) {
  const [selectedTask, setSelectedTask] = useState<
    AgentPresetTaskId | "all"
  >("all");
  const [selectedModel, setSelectedModel] = useState<string>("all");
  const [repeatPresetId, setRepeatPresetId] = useState<AgentPresetTaskId>(
    AGENT_TASK_PRESETS[0]?.id ?? "catalog-cheapest-home",
  );
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [repeatBusy, setRepeatBusy] = useState(false);

  const comparison = useMemo(
    () => buildAgentResilienceComparison(runs),
    [runs],
  );
  const models = useMemo(() => {
    const values = new Set(comparison.groups.map((group) => group.modelId));
    values.add(gate.modelId);
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [comparison.groups, gate.modelId]);
  const effectiveModel =
    selectedModel === "all" || models.includes(selectedModel)
      ? selectedModel
      : "all";
  const filteredGroups = comparison.groups.filter(
    (group) =>
      (selectedTask === "all" || group.presetId === selectedTask) &&
      (effectiveModel === "all" || group.modelId === effectiveModel),
  );
  const gateBlocker = describeGateBlocker(gate);
  const canRepeat =
    costConfirmed &&
    gateBlocker === null &&
    !runActive &&
    busy === null &&
    !repeatBusy;

  async function repeatLive(): Promise<void> {
    if (!canRepeat) return;
    setRepeatBusy(true);
    try {
      const started = await onRun({ presetId: repeatPresetId });
      if (started) setCostConfirmed(false);
    } finally {
      setRepeatBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="resilience-heading"
        data-testid="resilience-panel"
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <div className="space-y-1">
          <h2 id="resilience-heading" className="text-lg font-semibold">
            Mode resilience comparison
          </h2>
          <p className="max-w-3xl text-sm text-slate-600">
            Descriptive counts from the newest {AGENT_HISTORY_LIMIT} stored
            runs. A success is a <strong>full task pass</strong>: completed
            execution, an independent evaluation pass, and observed browser UI
            evidence. Business passes are shown separately. The comparison table
            never starts a run.
          </p>
          <p className="text-sm text-slate-600">
            A single run is anecdotal. Small samples are not statistically
            reliable evidence, and no significance test is performed.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Task
            <select
              data-testid="resilience-task-filter"
              value={selectedTask}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedTask(
                  value === "all" ? "all" : (value as AgentPresetTaskId),
                );
                if (value !== "all") setRepeatPresetId(value as AgentPresetTaskId);
              }}
              className={SELECT_CLASS}
            >
              <option value="all">All predefined tasks</option>
              {AGENT_TASK_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Model
            <select
              data-testid="resilience-model-filter"
              value={effectiveModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value="all">All stored models</option>
              {models.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
          </label>
        </div>

        {filteredGroups.length === 0 ? (
          <p
            data-testid="resilience-empty"
            className="rounded border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600"
          >
            No terminal stored runs match this filter. Run a predefined task in
            each layout to build a comparison; the comparison table never starts
            one for you. Use the live section below only after confirming its
            cost warning.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-sm">
              <caption className="sr-only">
                Stored predefined task outcomes by model, task, and layout mode
              </caption>
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-2 py-2">Model</th>
                  <th scope="col" className="px-2 py-2">Task</th>
                  <th scope="col" className="px-2 py-2">Mode</th>
                  <th scope="col" className="px-2 py-2">Full passes</th>
                  <th scope="col" className="px-2 py-2">Business passes</th>
                  <th scope="col" className="px-2 py-2">Sample size</th>
                  <th scope="col" className="px-2 py-2">Reliability</th>
                </tr>
              </thead>
              <tbody>
                {filteredGroups.flatMap((group) =>
                  resilienceModes().map((mode) => {
                    const stats = group.modes[mode];
                    const sample = describeResilienceSample(stats.sampleSize);
                    return (
                      <tr
                        key={`${group.modelId}:${group.presetId}:${mode}`}
                        data-testid="resilience-row"
                        data-model-id={group.modelId}
                        data-preset-id={group.presetId}
                        data-mode={mode}
                        className="border-b border-slate-100 align-top"
                      >
                        <td className="max-w-[16rem] break-all px-2 py-2 font-mono text-xs">
                          {group.modelId}
                        </td>
                        <td className="px-2 py-2">
                          {AGENT_TASK_PRESETS.find(
                            (preset) => preset.id === group.presetId,
                          )?.label ?? group.presetId}
                        </td>
                        <td className="px-2 py-2 font-medium">
                          {AGENT_UI_MODE_LABELS[mode]}
                        </td>
                        <td
                          data-testid="resilience-full-passes"
                          className="px-2 py-2"
                        >
                          {stats.fullPasses}
                        </td>
                        <td className="px-2 py-2">
                          {stats.businessPasses}
                        </td>
                        <td
                          data-testid="resilience-sample-size"
                          className="px-2 py-2"
                        >
                          {stats.sampleSize}
                        </td>
                        <td className="px-2 py-2">
                          <p className="font-medium">{sample.label}</p>
                          <p className="text-xs text-slate-600">{sample.detail}</p>
                          {!group.comparable ? (
                            <p className="mt-1 text-xs text-amber-800">
                              Needs terminal runs in both modes before comparing.
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-slate-500">
          Window: {comparison.windowSize} stored run
          {comparison.windowSize === 1 ? "" : "s"} considered. Excluded:{" "}
          {comparison.exclusions.noMode} without a captured mode,{" "}
          {comparison.exclusions.active} active,{" "}
          {comparison.exclusions.nonPreset} custom or verification.
        </p>
      </section>

      <section
        aria-labelledby="resilience-live-heading"
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <div className="space-y-1">
          <h3 id="resilience-live-heading" className="text-lg font-semibold">
            Collect another sample (live)
          </h3>
          <p className="max-w-3xl text-sm text-slate-600">
            A stored run is never rewritten. A new sample uses the{" "}
            <strong>current layout</strong> (
            {AGENT_UI_MODE_LABELS[uiMode]}) and the current verified browser
            model{" "}
            <code
              data-testid="resilience-live-model"
              className="break-all rounded bg-slate-100 px-1 py-0.5 font-mono text-xs"
            >
              {gate.modelId}
            </code>
            . Switch the layout above, then repeat the same preset to add the
            other mode. Each repetition needs a fresh cost confirmation.
          </p>
          <p data-testid="resilience-live-limits" className="text-sm text-slate-700">
            Default limits: {defaults.maxSteps} steps ·{" "}
            {Math.round(defaults.timeoutMs / 1_000)} s ·{" "}
            {formatUsd(defaults.maxCostUsd)} soft cost cap. Server hard caps:{" "}
            {caps.maxSteps} steps /{" "}
            {Math.round(caps.maxTimeoutMs / 60_000)} min /{" "}
            {formatUsd(caps.maxCostUsd)}.
          </p>
          <p className="text-sm text-slate-600">
            Usage is an SDK estimate, not a provider invoice; the soft cap may
            be exceeded by one response.
          </p>
        </div>

        {gateBlocker ? (
          <div
            data-testid="resilience-gate-blocker"
            role="status"
            className="space-y-1 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          >
            <p className="font-semibold">{gateBlocker.title}</p>
            <p>{gateBlocker.detail}</p>
          </div>
        ) : null}

        <label className="block text-sm font-medium">
          Preset to repeat
          <select
            data-testid="resilience-repeat-preset"
            value={repeatPresetId}
            disabled={runActive || busy !== null}
            onChange={(event) =>
              setRepeatPresetId(event.target.value as AgentPresetTaskId)
            }
            className={SELECT_CLASS}
          >
            {AGENT_TASK_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            data-testid="resilience-cost-confirm"
            checked={costConfirmed}
            disabled={runActive || busy !== null}
            onChange={(event) => setCostConfirmed(event.target.checked)}
            className="mt-1"
          />
          <span>
            I understand this starts a new billable agent run and that the
            displayed soft cost cap is not a provider-side hard limit.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="resilience-run-live"
            disabled={!canRepeat}
            onClick={() => void repeatLive()}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {repeatBusy || busy === "task"
              ? "Starting..."
              : "Run preset live"}
          </button>
          {runActive ? (
            <span className="text-sm text-amber-900">
              An agent run is active. Wait for it to finish or cancel it before
              collecting another sample.
            </span>
          ) : null}
          {!runActive && gateBlocker === null && !costConfirmed ? (
            <span className="text-sm text-slate-600">
              Confirm the cost warning to enable the live repetition.
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
