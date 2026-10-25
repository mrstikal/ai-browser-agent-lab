"use client";

import { type FormEvent, useState } from "react";
import type { AgentDashboardView } from "@/lib/agent-dashboard-view";
import type { AgentRunLimits } from "@/lib/agent-ipc";
import {
  AGENT_TASK_PRESETS,
  buildPresetTaskInstruction,
  getAgentTaskPreset,
  isAgentPresetTaskId,
  type AgentPresetTaskId,
  type AgentTaskStartRequest,
} from "@/lib/agent-tasks";
import {
  describeExecutionStatus,
  describeGateBlocker,
  describeOverallTaskResult,
  describeStopReason,
  describeTaskResult,
  formatDuration,
  formatEstimatedCost,
  formatTokens,
  shouldShowOverallTaskResult,
  type RunTone,
} from "@/lib/agent-run-display";
import { formatUsd } from "@/lib/format";
import type { DashboardAction, DashboardFeedback, TaskLimitsCaps } from "./agent-dashboard";

const TONE_CLASSES: Record<RunTone, string> = {
  neutral: "border-slate-300 bg-slate-50 text-slate-800",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  danger: "border-red-300 bg-red-50 text-red-800",
};

export interface TaskPanelProps {
  readonly view: AgentDashboardView;
  readonly defaults: AgentRunLimits;
  readonly caps: TaskLimitsCaps;
  readonly maxTaskChars: number;
  readonly runActive: boolean;
  readonly polling: boolean;
  readonly busy: DashboardAction | null;
  readonly feedback: DashboardFeedback | null;
  readonly onRun: (request: AgentTaskStartRequest) => Promise<boolean>;
  readonly onCancel: (runId: string) => void;
}

export function TaskPanel({
  view,
  defaults,
  caps,
  maxTaskChars,
  runActive,
  polling,
  busy,
  feedback,
  onRun,
  onCancel,
}: TaskPanelProps) {
  const [task, setTask] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState<
    AgentPresetTaskId | "custom"
  >("custom");
  const { gate, activeRun, latestTask } = view;

  const preset =
    selectedPresetId === "custom"
      ? null
      : getAgentTaskPreset(selectedPresetId);
  const presetInstruction =
    preset === null ? null : buildPresetTaskInstruction(gate.origin, preset.id);
  const trimmed = task.trim();
  const whitespaceOnly = task.length > 0 && trimmed.length === 0;
  const valid =
    preset !== null || (trimmed.length > 0 && trimmed.length <= maxTaskChars);
  const gateBlocker = describeGateBlocker(gate);
  const canRun = valid && gateBlocker === null && !runActive && busy === null;

  const activeTask = activeRun?.kind === "task" ? activeRun : null;
  const verificationActive = activeRun?.kind === "verification";
  const displayRun = activeTask ?? latestTask;
  const isActiveTask =
    activeTask !== null && displayRun?.runId === activeTask.runId;
  const taskFeedback = feedback?.scope === "task" ? feedback : null;
  const overall = displayRun === null ? null : describeOverallTaskResult(displayRun);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canRun) return;
    await onRun(preset === null ? { task: trimmed } : { presetId: preset.id });
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="task-controls-heading"
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <div className="space-y-1">
          <h2 id="task-controls-heading" className="text-lg font-semibold">
            Run a task
          </h2>
          <p data-testid="agent-model-notice" className="text-sm text-slate-700">
            Browser model: <span className="break-all font-medium">{gate.modelId}</span>
            {" · "}SDK {gate.sdkVersion ?? "unavailable"}
            {" · "}
            <span className="break-all">{gate.origin}</span>
          </p>
          <p data-testid="agent-limits-notice" className="text-sm text-slate-700">
            Validated limits: {defaults.maxSteps} steps ·{" "}
            {Math.round(defaults.timeoutMs / 1_000)} s ·{" "}
            {formatUsd(defaults.maxCostUsd)} soft cost cap (server-enforced hard
            caps: {caps.maxSteps} steps /{" "}
            {Math.round(caps.maxTimeoutMs / 60_000)} min /{" "}
            {formatUsd(caps.maxCostUsd)}).
          </p>
          <p className="text-sm text-slate-600">
            The server validates the model and applies these limits. A run can
            overshoot the soft cost cap by one response. Execution status is
            never presented as task success. Screenshot/vision input stays
            unverified until a tool result carries image content.
          </p>
        </div>

        {gateBlocker ? (
          <div
            data-testid="agent-gate-blocker"
            role="status"
            className="space-y-1 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          >
            <p className="font-semibold">{gateBlocker.title}</p>
            <p>{gateBlocker.detail}</p>
          </div>
        ) : null}

        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="agent-preset" className="block text-sm font-medium">
              Preset
            </label>
            <select
              id="agent-preset"
              data-testid="agent-preset-select"
              value={selectedPresetId}
              disabled={runActive || busy !== null}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedPresetId(
                  isAgentPresetTaskId(value) ? value : "custom",
                );
              }}
              className="w-full rounded border border-slate-300 p-2 text-sm disabled:bg-slate-100"
            >
              <option value="custom">Custom task</option>
              {AGENT_TASK_PRESETS.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500">
              Catalog expected values are checked on the server and never sent
              to the model. Form tasks must state the prescribed submission
              values in the instruction.
            </p>
          </div>

          {preset !== null ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">Preset instruction</p>
              <pre
                data-testid="agent-preset-instruction"
                className="overflow-x-auto rounded bg-slate-100 p-3 text-xs text-slate-800"
              >
                {presetInstruction}
              </pre>
            </div>
          ) : (
            <>
              <label htmlFor="agent-task" className="block text-sm font-medium">
                Task
              </label>
              <textarea
                id="agent-task"
                data-testid="agent-task-input"
                value={task}
                maxLength={maxTaskChars}
                rows={5}
                disabled={runActive || busy !== null}
                onChange={(event) => setTask(event.target.value)}
                aria-describedby="agent-task-help"
                className="w-full rounded border border-slate-300 p-3 text-sm disabled:bg-slate-100"
                placeholder="Read the main heading on the shop page and return it as JSON."
              />
              <p id="agent-task-help" className="text-xs text-slate-500">
                {task.length} / {maxTaskChars} characters. One bounded task per
                run; the agent works only on the local app origin.
              </p>
              {whitespaceOnly ? (
                <p role="alert" className="text-sm text-red-700">
                  The task cannot contain only whitespace.
                </p>
              ) : null}
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              data-testid="agent-run-task"
              disabled={!canRun}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy === "task" ? "Starting..." : "Run task"}
            </button>
            {gateBlocker ? null : runActive ? (
              <span data-testid="agent-run-active-note" className="text-sm text-amber-900">
                {verificationActive
                  ? "A verification run is active. Task runs wait for it to finish."
                  : "An agent run is already active. Wait for it to finish or cancel it."}
              </span>
            ) : valid ? (
              <span className="text-sm text-slate-600">
                Ready. The task is sent to the verified local browser agent.
              </span>
            ) : null}
          </div>
        </form>

        {taskFeedback ? (
          <p
            role={taskFeedback.tone === "error" ? "alert" : "status"}
            data-testid="agent-task-feedback"
            className={
              taskFeedback.tone === "error"
                ? "text-sm text-red-700"
                : "text-sm text-emerald-800"
            }
          >
            {taskFeedback.text}
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="task-run-heading"
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="task-run-heading" className="text-lg font-semibold">
            {isActiveTask ? "Current task run" : "Last task run"}
          </h2>
          {isActiveTask && displayRun.status === "running" ? (
            <button
              type="button"
              data-testid="agent-cancel-run"
              onClick={() => onCancel(displayRun.runId)}
              disabled={busy !== null}
              className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 disabled:opacity-50"
            >
              {busy === "cancel" ? "Cancelling..." : "Cancel run"}
            </button>
          ) : null}
        </div>

        {displayRun === null ? (
          <p data-testid="agent-run-empty" className="text-sm text-slate-600">
            No task run yet. Enter a task above and start it when the model is
            verified.
          </p>
        ) : (
          <>
            {verificationActive ? (
              <p data-testid="agent-task-blocked-note" className="text-sm text-amber-900">
                A verification run is active. This is the last task run.
              </p>
            ) : null}
            <div
              className={`space-y-1 rounded border p-3 text-sm ${
                TONE_CLASSES[describeExecutionStatus(displayRun).tone]
              }`}
            >
              <p data-testid="agent-run-execution" className="font-semibold">
                {describeExecutionStatus(displayRun).label}
              </p>
              <p data-testid="agent-run-stop-reason">
                {describeStopReason(displayRun.stopReason)}
              </p>
            </div>
            <div
              className={`space-y-1 rounded border p-3 text-sm ${
                TONE_CLASSES[describeTaskResult(displayRun.evaluation).tone]
              }`}
            >
              <p data-testid="agent-run-task-result">
                <span className="font-semibold">
                  {describeTaskResult(displayRun.evaluation).label}.
                </span>{" "}
                {describeTaskResult(displayRun.evaluation).detail}
              </p>
            </div>
            {overall !== null && shouldShowOverallTaskResult(displayRun) ? (
              <div
                className={`space-y-1 rounded border p-3 text-sm ${
                  TONE_CLASSES[overall.tone]
                }`}
              >
                <p data-testid="agent-run-overall" className="font-semibold">
                  {overall.label}
                </p>
                <p>{overall.detail}</p>
              </div>
            ) : null}
            {isActiveTask && displayRun.status === "cancelling" ? (
              <p className="text-sm text-amber-900">
                Cancellation requested. Waiting for the worker to settle; the
                paid lock is released only after the process is proven gone.
              </p>
            ) : null}
            {isActiveTask && displayRun.status === "hung" ? (
              <p role="alert" className="text-sm text-red-800">
                This run is hung. The supervisor is attempting verified forced
                cleanup in-process. If the worker group cannot be verified, a
                server restart is required and startup recovery will retry the
                cleanup.
              </p>
            ) : null}
            {isActiveTask && polling ? (
              <p className="text-xs text-slate-500">
                Status updates every second.
              </p>
            ) : null}
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium text-slate-500">Run ID</dt>
                <dd className="break-all font-mono text-xs">{displayRun.runId}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Model</dt>
                <dd className="break-all">{displayRun.modelId}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Preset</dt>
                <dd data-testid="agent-run-preset">
                  {displayRun.presetId === null
                    ? "Custom task"
                    : getAgentTaskPreset(displayRun.presetId).label}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Started</dt>
                <dd>{displayRun.startedAt}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Ended</dt>
                <dd>{displayRun.endedAt ?? "not finished"}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Steps and duration</dt>
                <dd>
                  {displayRun.steps ?? "unknown"} steps ·{" "}
                  {formatDuration(displayRun.durationMs)}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Run limits</dt>
                <dd>
                  {displayRun.limits.maxSteps} steps ·{" "}
                  {Math.round(displayRun.limits.timeoutMs / 1_000)} s ·{" "}
                  {formatUsd(displayRun.limits.maxCostUsd)} soft cost cap
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Tokens and cost</dt>
                <dd>
                  {formatTokens(displayRun.usage)} ·{" "}
                  {formatEstimatedCost(displayRun.usage)} (SDK estimate)
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Vision evidence</dt>
                <dd>
                  {displayRun.vision === "observed" ? "Observed" : "Unverified"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">UI evidence</dt>
                <dd>
                  {displayRun.uiEvidence === "observed" ? "Observed" : "Unverified"}
                  <span className="mt-1 block text-xs text-slate-500">
                    Observed means a successful browser JavaScript tool event
                    was persisted. It is trace evidence, not cryptographic proof.
                  </span>
                </dd>
              </div>
            </dl>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-slate-700">
                Task text
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-3 text-xs text-slate-800">
                {displayRun.task}
              </pre>
            </details>
            {displayRun.outputText ? (
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-700">Output</h3>
                <pre
                  data-testid="agent-run-output"
                  className="overflow-x-auto rounded bg-slate-100 p-3 text-xs text-slate-800"
                >
                  {displayRun.outputText}
                </pre>
              </div>
            ) : displayRun.status === "running" ||
              displayRun.status === "cancelling" ? (
              <p className="text-sm text-slate-600">No output yet.</p>
            ) : (
              <p className="text-sm text-slate-600">
                The run returned no text output.
              </p>
            )}
            {displayRun.error ? (
              <p role="alert" className="text-sm text-red-700">
                {displayRun.error}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
