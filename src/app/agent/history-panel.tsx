"use client";

import {
  AGENT_HISTORY_LIMIT,
  type AgentRunSummary,
} from "@/lib/agent-history";
import {
  describeExecutionStatus,
  describeHistoryResult,
  describeStopReason,
  describeUiMode,
  formatDuration,
  formatEstimatedCost,
  formatRunTimestamp,
  formatTokens,
  type RunTone,
} from "@/lib/agent-run-display";
import { getAgentTaskPreset } from "@/lib/agent-tasks";

const TONE_TEXT: Record<RunTone, string> = {
  neutral: "text-slate-800",
  success: "text-emerald-800",
  warning: "text-amber-900",
  danger: "text-red-800",
};

function historyTitle(run: AgentRunSummary): string {
  if (run.kind === "verification") return "Model verification";
  if (run.presetId !== null) return getAgentTaskPreset(run.presetId).label;
  return "Custom task";
}

export interface HistoryPanelProps {
  readonly history: readonly AgentRunSummary[];
  readonly selectedRunId: string | null;
  readonly onSelect: (runId: string | null) => void;
}

export function HistoryPanel({
  history,
  selectedRunId,
  onSelect,
}: HistoryPanelProps) {
  return (
    <section
      aria-labelledby="agent-history-heading"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="agent-history-heading" className="text-lg font-semibold">
            Recent runs
          </h2>
          <p className="max-w-2xl text-sm text-slate-600">
            Newest first, bounded to the {AGENT_HISTORY_LIMIT} most recent
            persisted runs. History survives a restart. Select a run to load its
            saved trace below; cost and tokens stay <code>unknown</code> when
            the SDK did not report them.
          </p>
        </div>
        {selectedRunId !== null ? (
          <button
            type="button"
            data-testid="agent-history-follow"
            onClick={() => onSelect(null)}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800"
          >
            Follow active/latest
          </button>
        ) : null}
      </div>

      {history.length === 0 ? (
        <p data-testid="agent-history-empty" className="text-sm text-slate-600">
          No saved runs yet.
        </p>
      ) : (
        <>
          <p data-testid="agent-history-count" className="text-xs text-slate-500">
            Showing {history.length}{" "}
            {history.length === 1 ? "saved run" : "saved runs"}.
          </p>
          <ol
            data-testid="agent-history"
            className="max-h-[36rem] space-y-3 overflow-y-auto pr-1"
          >
            {history.map((run) => {
              const execution = describeExecutionStatus(run);
              const result = describeHistoryResult(run);
              const selected = selectedRunId === run.runId;
              return (
                <li
                  key={run.runId}
                  data-testid="agent-history-item"
                  data-run-id={run.runId}
                  className={`space-y-3 rounded border p-3 ${
                    selected
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-semibold">{historyTitle(run)}</p>
                      <p className="break-all font-mono text-xs text-slate-500">
                        {run.runId}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid="agent-history-select"
                      aria-pressed={selected}
                      onClick={() => onSelect(selected ? null : run.runId)}
                      className={
                        selected
                          ? "rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
                          : "rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800"
                      }
                    >
                      {selected ? "Showing trace" : "Show trace"}
                    </button>
                  </div>

                  <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <dt className="font-medium text-slate-500">Model</dt>
                      <dd
                        data-testid="agent-history-model"
                        className="break-all"
                      >
                        {run.modelId}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Started</dt>
                      <dd data-testid="agent-history-started">
                        {formatRunTimestamp(run.startedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Ended</dt>
                      <dd data-testid="agent-history-ended">
                        {formatRunTimestamp(run.endedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">
                        Steps and duration
                      </dt>
                      <dd data-testid="agent-history-steps">
                        {run.steps ?? "unknown"} steps ·{" "}
                        {formatDuration(run.durationMs)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">
                        Tokens and cost
                      </dt>
                      <dd data-testid="agent-history-usage">
                        {formatTokens(run.usage)} ·{" "}
                        {formatEstimatedCost(run.usage)} (SDK estimate)
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">UI mode</dt>
                      <dd data-testid="agent-history-ui-mode">
                        {describeUiMode(run.uiMode)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Execution</dt>
                      <dd
                        data-testid="agent-history-execution"
                        className={TONE_TEXT[execution.tone]}
                      >
                        {execution.label} ·{" "}
                        {describeStopReason(run.stopReason)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">
                        Business result
                      </dt>
                      <dd
                        data-testid="agent-history-result"
                        className={TONE_TEXT[result.tone]}
                      >
                        {result.label}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">UI evidence</dt>
                      <dd data-testid="agent-history-ui-evidence">
                        {run.uiEvidence === "observed"
                          ? "Observed"
                          : "Unverified"}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">
                        Vision evidence
                      </dt>
                      <dd data-testid="agent-history-vision">
                        {run.vision === "observed" ? "Observed" : "Unverified"}
                      </dd>
                    </div>
                  </dl>
                  <p className="text-xs text-slate-500">{result.detail}</p>
                  {run.errorSummary !== null ? (
                    <p
                      data-testid="agent-history-error"
                      className="text-xs text-red-700"
                    >
                      Error: {run.errorSummary}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
