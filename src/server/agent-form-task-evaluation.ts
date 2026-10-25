import {
  getAgentFormTaskPreset,
  isAgentFormTaskId,
  parseFormTaskAnswer,
  type AgentInquiryFormExpected,
  type AgentSupportFormExpected,
  type FormTaskAnswer,
} from "../lib/agent-tasks";
import type { AgentRunEvaluation, AgentRunRecord } from "./agent-runs";
import {
  listInquirySubmissionIds,
  loadInquirySubmission,
  type InquirySubmissionRecord,
} from "./inquiry-form";
import {
  listSupportSubmissionIds,
  loadSupportSubmission,
  type SupportSubmissionRecord,
} from "./support-form";
import type { Storage } from "./storage";

/**
 * Deterministic business evaluator for form Tasks 4-5. The run record carries
 * the submission IDs that existed before the worker launched; exactly one new
 * record of the task's form type must exist, every prescribed field must match,
 * and the agent's returned UUID must identify that new record.
 */

function boundReason(reason: string): string {
  return reason.slice(0, 1_000);
}

function fail(reason: string): AgentRunEvaluation {
  return { status: "failed", reason: boundReason(reason) };
}

function pass(reason: string): AgentRunEvaluation {
  return { status: "passed", reason: boundReason(reason) };
}

function answerIdOf(answer: FormTaskAnswer): string {
  return answer.presetId === "form-support-request"
    ? answer.answer.requestId
    : answer.answer.confirmationId;
}

function compareSupportRecord(
  record: SupportSubmissionRecord,
  expected: AgentSupportFormExpected,
): string | null {
  if (record.requestId !== record.id) {
    return "The support record request ID does not match its stored ID.";
  }
  if (record.fullName !== expected.fullName) {
    return `Expected support name "${expected.fullName}" but found "${record.fullName}".`;
  }
  if (record.email !== expected.email) {
    return `Expected support email "${expected.email}" but found "${record.email}".`;
  }
  if (record.subject !== expected.subject) {
    return `Expected support subject "${expected.subject}" but found "${record.subject}".`;
  }
  if (record.priority !== expected.priority) {
    return `Expected support priority "${expected.priority}" but found "${record.priority}".`;
  }
  if (record.description !== expected.description) {
    return `Expected support description "${expected.description}" but found "${record.description}".`;
  }
  if (record.confirmLocalTest !== expected.confirmLocalTest) {
    return "The local-test submission confirmation was not checked.";
  }
  return null;
}

function compareInquiryRecord(
  record: InquirySubmissionRecord,
  expected: AgentInquiryFormExpected,
): string | null {
  if (record.requestId !== record.id) {
    return "The inquiry record request ID does not match its stored ID.";
  }
  if (record.fullName !== expected.fullName) {
    return `Expected inquiry name "${expected.fullName}" but found "${record.fullName}".`;
  }
  if (record.email !== expected.email) {
    return `Expected inquiry email "${expected.email}" but found "${record.email}".`;
  }
  if (record.productId !== expected.productId) {
    return `Expected inquiry product ${expected.productId} (${expected.productName}) but found ${record.productId}.`;
  }
  if (record.inquiryType !== expected.inquiryType) {
    return `Expected inquiry type "${expected.inquiryType}" but found "${record.inquiryType}".`;
  }
  if (record.message !== expected.message) {
    return `Expected inquiry message "${expected.message}" but found "${record.message}".`;
  }
  return null;
}

/**
 * Business evaluation only. A custom or verification run is never evaluated;
 * an incomplete form run fails because a limit/cancel/interruption is not a
 * pass. UI evidence stays a separate run-record field.
 */
export async function evaluateFormTaskRun(
  record: AgentRunRecord,
  storage: Storage,
): Promise<AgentRunEvaluation> {
  if (
    record.kind !== "task" ||
    record.presetId === null ||
    !isAgentFormTaskId(record.presetId)
  ) {
    return { status: "not_evaluated", reason: null };
  }
  if (record.status !== "completed") {
    return fail(
      record.error ??
        `The run ended as ${record.status} without completing the task.`,
    );
  }
  if (record.stopReason !== "completed") {
    return fail(`The SDK stopped the run (${record.stopReason ?? "unknown"}).`);
  }

  const preset = getAgentFormTaskPreset(record.presetId);
  const baseline = record.formBaseline;
  if (!baseline) {
    return fail("The run has no form submission baseline.");
  }
  if (baseline.form !== preset.form) {
    return fail("The form submission baseline type does not match the task.");
  }

  const parsed = parseFormTaskAnswer(record.presetId, record.outputText);
  if (!parsed.ok) {
    return fail(parsed.reason);
  }
  if (parsed.answer.presetId !== record.presetId) {
    return fail("The parsed answer does not match the task preset.");
  }

  const currentIds =
    preset.form === "support"
      ? await listSupportSubmissionIds(storage)
      : await listInquirySubmissionIds(storage);
  const baselineIds = new Set(baseline.submissionIds);
  const newIds = currentIds.filter((id) => !baselineIds.has(id));
  if (newIds.length !== 1) {
    return fail(
      `Expected exactly one new ${preset.form} submission but found ${newIds.length}.`,
    );
  }
  const newId = newIds[0];
  if (!newId) {
    return fail(`The new ${preset.form} submission ID is missing.`);
  }
  const answerId = answerIdOf(parsed.answer);
  if (answerId.toLowerCase() !== newId.toLowerCase()) {
    return fail(
      `The returned ID does not identify the new ${preset.form} record.`,
    );
  }

  if (preset.form === "support") {
    const stored = await loadSupportSubmission(storage, newId);
    if (!stored) {
      return fail("The new support record could not be read.");
    }
    const mismatch = compareSupportRecord(stored, preset.expected);
    return mismatch
      ? fail(mismatch)
      : pass(`Matched the new support record ${newId} with all prescribed fields.`);
  }

  const stored = await loadInquirySubmission(storage, newId);
  if (!stored) {
    return fail("The new inquiry record could not be read.");
  }
  const mismatch = compareInquiryRecord(stored, preset.expected);
  return mismatch
    ? fail(mismatch)
    : pass(
        `Matched the new inquiry record ${newId} with product ${preset.expected.productId} and all prescribed fields.`,
      );
}
