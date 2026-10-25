import type {
  AgentCatalogTaskId,
  AgentPresetTaskId,
} from "../lib/agent-tasks";
import {
  startAgentRun,
  type AgentStartResult,
  type StartAgentRunOptions,
} from "./agent-manager";
import {
  isTerminalAgentRunStatus,
  loadAgentRun,
  saveAgentRun,
  type AgentRunRecord,
} from "./agent-runs";
import { evaluatePresetTaskRun } from "./agent-preset-evaluation";
import { createStorage, type Storage } from "./storage";

export {
  catalogTaskExpectations,
  evaluateCatalogTaskRun,
} from "./agent-task-evaluation";
export { evaluateFormTaskRun } from "./agent-form-task-evaluation";
export { evaluatePresetTaskRun } from "./agent-preset-evaluation";

export interface PresetTaskSettlerOptions {
  readonly storage: Storage;
  readonly now?: (() => Date) | undefined;
}

/**
 * Persists the deterministic evaluation once, at run termination, so later
 * resets or history reads never recompute or rewrite it. The hook receives the
 * in-memory terminal record; if the supervisor's terminal save failed, using
 * that record (instead of the stale on-disk snapshot) still persists a
 * terminal run with its evaluation.
 */
export function buildPresetTaskSettler(
  options: PresetTaskSettlerOptions,
): (record: AgentRunRecord) => Promise<void> {
  return async (record) => {
    if (record.kind !== "task" || record.presetId === null) return;
    const current = await loadAgentRun(options.storage, record.runId);
    if (!current || current.kind !== "task" || current.presetId === null) {
      return;
    }
    if (current.evaluation.status !== "not_evaluated") return;
    const terminal = isTerminalAgentRunStatus(record.status)
      ? record
      : current;
    if (!isTerminalAgentRunStatus(terminal.status)) return;
    const evaluation = await evaluatePresetTaskRun(terminal, options.storage);
    await saveAgentRun(options.storage, {
      ...terminal,
      evaluation,
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
    });
  };
}

/** Backward-compatible name for catalog-only callers and tests. */
export const buildCatalogTaskSettler = buildPresetTaskSettler;

export interface StartPresetTaskRunOptions
  extends Omit<
    StartAgentRunOptions,
    "kind" | "task" | "presetId" | "onSettled"
  > {
  readonly presetId: AgentPresetTaskId;
}

/**
 * Starts one predefined task through the supervisor. The supervisor builds the
 * neutral instruction from the preset ID and the configured origin; this
 * wrapper persists the independent business evaluation at settle.
 */
export async function startPresetTaskRun(
  options: StartPresetTaskRunOptions,
): Promise<AgentStartResult> {
  const env = options.env ?? process.env;
  const storage = options.storage ?? createStorage(env);
  return startAgentRun({
    ...options,
    env,
    storage,
    kind: "task",
    presetId: options.presetId,
    onSettled: buildPresetTaskSettler({ storage, now: options.now }),
  });
}

export interface StartCatalogTaskRunOptions
  extends Omit<StartPresetTaskRunOptions, "presetId"> {
  readonly presetId: AgentCatalogTaskId;
}

/** Backward-compatible catalog-only entry point. */
export async function startCatalogTaskRun(
  options: StartCatalogTaskRunOptions,
): Promise<AgentStartResult> {
  return startPresetTaskRun(options);
}
