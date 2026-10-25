import {
  isAgentCatalogTaskId,
  isAgentFormTaskId,
} from "../lib/agent-tasks";
import type { AgentRunEvaluation, AgentRunRecord } from "./agent-runs";
import { evaluateFormTaskRun } from "./agent-form-task-evaluation";
import { evaluateCatalogTaskRun } from "./agent-task-evaluation";
import type { Storage } from "./storage";

/**
 * Dispatches the one deterministic evaluator for a preset task. Catalog
 * evaluation is synchronous; form evaluation reads the persisted submissions
 * and the run's pre-launch baseline. This module has no supervisor imports so
 * restart recovery can use the same dispatch without a cycle.
 */
export async function evaluatePresetTaskRun(
  record: AgentRunRecord,
  storage: Storage,
): Promise<AgentRunEvaluation> {
  if (record.kind !== "task" || record.presetId === null) {
    return { status: "not_evaluated", reason: null };
  }
  if (isAgentCatalogTaskId(record.presetId)) {
    return evaluateCatalogTaskRun(record);
  }
  if (isAgentFormTaskId(record.presetId)) {
    return evaluateFormTaskRun(record, storage);
  }
  return { status: "not_evaluated", reason: null };
}
