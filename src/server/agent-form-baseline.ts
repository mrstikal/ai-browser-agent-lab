import {
  AGENT_FORM_BASELINE_MAX_IDS,
  getAgentFormTaskPreset,
  isAgentFormTaskId,
  type AgentFormTaskType,
  type AgentPresetTaskId,
} from "../lib/agent-tasks";
import type { AgentFormBaseline } from "./agent-runs";
import { listInquirySubmissionIds } from "./inquiry-form";
import type { Storage } from "./storage";
import { listSupportSubmissionIds } from "./support-form";

export class AgentFormBaselineLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFormBaselineLimitError";
  }
}

export async function listFormSubmissionIds(
  storage: Storage,
  form: AgentFormTaskType,
): Promise<string[]> {
  return form === "support"
    ? listSupportSubmissionIds(storage)
    : listInquirySubmissionIds(storage);
}

/**
 * Captures the IDs that already exist before a form-task worker launches. The
 * supervisor stores this snapshot in the run record before spawn; the terminal
 * evaluator then requires exactly one ID outside it.
 */
export function assertFormBaselineSize(
  form: AgentFormTaskType,
  count: number,
): void {
  if (count > AGENT_FORM_BASELINE_MAX_IDS) {
    throw new AgentFormBaselineLimitError(
      `The existing ${form} submissions exceed the ${AGENT_FORM_BASELINE_MAX_IDS}-record baseline limit; reset test submissions before running this form task.`,
    );
  }
}

export async function captureFormBaseline(
  storage: Storage,
  presetId: AgentPresetTaskId | null,
): Promise<AgentFormBaseline | null> {
  if (presetId === null || !isAgentFormTaskId(presetId)) return null;
  const preset = getAgentFormTaskPreset(presetId);
  const submissionIds = await listFormSubmissionIds(storage, preset.form);
  assertFormBaselineSize(preset.form, submissionIds.length);
  return { form: preset.form, submissionIds };
}
