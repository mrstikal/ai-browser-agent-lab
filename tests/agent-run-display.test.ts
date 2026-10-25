import { describe, expect, it } from "vitest";
import type { AgentGate } from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";
import { pickAgentDashboardView } from "@/lib/agent-dashboard-view";
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
} from "@/lib/agent-run-display";

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 2,
    runId: "11111111-1111-4111-8111-111111111111",
    kind: "task",
    presetId: null,
    formBaseline: null,
    task: "Read the main heading.",
    modelId: "openrouter/openai/gpt-5.6-luna",
    origin: "http://127.0.0.1:3000",
    limits: { maxSteps: 30, timeoutMs: 180_000, maxCostUsd: 1 },
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-10-24T10:00:00.000Z",
    endedAt: "2026-10-24T10:00:05.000Z",
    updatedAt: "2026-10-24T10:00:05.000Z",
    steps: 3,
    durationMs: 5_000,
    outputText: '{"heading":"Shop"}',
    error: null,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostUsd: 0.01,
    },
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "not_evaluated", reason: null },
    uiEvidence: "unverified",
    worker: null,
    eventCount: 0,
    lastSeq: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
    ...overrides,
  };
}

function makeGate(overrides: Partial<AgentGate> = {}): AgentGate {
  return {
    keyAvailable: true,
    verified: true,
    reason: "verified",
    modelId: "openrouter/openai/gpt-5.6-luna",
    sdkVersion: "0.1.0",
    origin: "http://127.0.0.1:3000",
    verifiedAt: "2026-10-24T09:00:00.000Z",
    vision: "unverified",
    ...overrides,
  };
}

describe("agent run display", () => {
  it("never presents completed execution as task success", () => {
    expect(describeExecutionStatus(makeRun())).toEqual({
      label: "Execution completed",
      tone: "neutral",
    });
    expect(describeTaskResult(makeRun().evaluation)).toMatchObject({
      label: "Not evaluated",
      tone: "neutral",
    });
  });

  it("labels non-success stop reasons and failures honestly", () => {
    expect(
      describeExecutionStatus(makeRun({ stopReason: "cancelled" })),
    ).toEqual({
      label: "Execution stopped (cancelled)",
      tone: "warning",
    });
    expect(
      describeExecutionStatus(makeRun({ stopReason: "max_steps" })),
    ).toEqual({
      label: "Execution stopped (step limit)",
      tone: "warning",
    });
    expect(
      describeExecutionStatus(makeRun({ stopReason: "cost_limit" })).label,
    ).toBe("Execution stopped (soft cost limit)");
    expect(
      describeExecutionStatus(makeRun({ stopReason: null })).label,
    ).toBe("Execution stopped (no stop reason)");
    expect(
      describeExecutionStatus(makeRun({ status: "failed", stopReason: "error" })),
    ).toEqual({ label: "Execution failed", tone: "danger" });
    expect(
      describeExecutionStatus(makeRun({ status: "running", endedAt: null })),
    ).toEqual({ label: "Running", tone: "neutral" });
    expect(describeExecutionStatus(makeRun({ status: "cancelling" }))).toEqual({
      label: "Cancelling",
      tone: "warning",
    });
    expect(describeExecutionStatus(makeRun({ status: "hung" }))).toEqual({
      label: "Hung — cleanup required",
      tone: "danger",
    });
    expect(
      describeExecutionStatus(makeRun({ status: "interrupted" })),
    ).toEqual({
      label: "Interrupted by restart",
      tone: "warning",
    });
  });

  it("describes SDK stop reasons in words", () => {
    expect(describeStopReason("completed")).toBe("The SDK completed the run.");
    expect(describeStopReason("cancelled")).toBe("The run was cancelled.");
    expect(describeStopReason("max_steps")).toBe(
      "The step limit ended the run.",
    );
    expect(describeStopReason("cost_limit")).toBe(
      "The soft cost limit ended the run.",
    );
    expect(describeStopReason(null)).toBe(
      "No SDK stop reason was recorded.",
    );
  });

  it("reports task evaluation separately from execution", () => {
    expect(
      describeTaskResult({
        status: "passed",
        reason: "The evaluator matched the answer.",
      }),
    ).toEqual({
      label: "Task passed",
      tone: "success",
      detail: "The evaluator matched the answer.",
    });
    expect(
      describeTaskResult({ status: "failed", reason: "Wrong product." }),
    ).toEqual({
      label: "Task failed",
      tone: "danger",
      detail: "Wrong product.",
    });
    expect(
      describeTaskResult({ status: "failed", reason: null }).detail,
    ).toContain("independent evaluator");
  });

  it("shows unknown cost and tokens instead of zero", () => {
    expect(formatEstimatedCost(null)).toBe("unknown");
    expect(
      formatEstimatedCost({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
      }),
    ).toBe("unknown");
    expect(
      formatEstimatedCost({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedCostUsd: 0,
      }),
    ).toBe("$0.00");
    expect(formatTokens(null)).toBe("unknown");
    expect(formatTokens(makeRun().usage)).toBe("15 tokens");
    expect(formatDuration(null)).toBe("unknown");
    expect(formatDuration(25)).toBe("25 ms");
    expect(formatDuration(1_500)).toBe("1.5 s");
  });

  it("explains missing-key and verification gate states", () => {
    expect(describeGateBlocker(makeGate())).toBeNull();
    expect(
      describeGateBlocker(makeGate({ keyAvailable: false, reason: "key-required" })),
    ).toMatchObject({ title: "OpenRouter key required" });
    expect(
      describeGateBlocker(
        makeGate({ verified: false, reason: "verification-required" }),
      ),
    ).toMatchObject({ title: "Verification required" });
    expect(
      describeGateBlocker(
        makeGate({ verified: false, reason: "model-mismatch" }),
      ),
    ).toMatchObject({ title: "A different browser model is stamped" });
    expect(
      describeGateBlocker(
        makeGate({ verified: false, reason: "sdk-unavailable" }),
      ),
    ).toMatchObject({ title: "Browser SDK unavailable" });
  });
});

describe("overall task result", () => {
  it("requires execution, business, and UI evidence for a full pass", () => {
    const run = makeRun({
      presetId: "catalog-cheapest-home",
      evaluation: { status: "passed", reason: "Matched." },
      uiEvidence: "observed",
    });
    expect(describeOverallTaskResult(run)).toMatchObject({
      label: "Full task pass",
      tone: "success",
      fullPass: true,
    });
  });

  it("does not claim a full pass without observed UI evidence", () => {
    const run = makeRun({
      presetId: "catalog-cheapest-home",
      evaluation: { status: "passed", reason: "Matched." },
      uiEvidence: "unverified",
    });
    expect(describeOverallTaskResult(run)).toMatchObject({
      label: "Business result passed; UI unverified",
      tone: "warning",
      fullPass: false,
    });
  });

  it("does not claim a full pass for an incomplete execution", () => {
    const run = makeRun({
      presetId: "catalog-cheapest-home",
      status: "failed",
      stopReason: null,
      evaluation: { status: "passed", reason: "Matched." },
      uiEvidence: "observed",
    });
    expect(describeOverallTaskResult(run)).toMatchObject({
      label: "Business result passed; execution not completed",
      tone: "warning",
      fullPass: false,
    });
  });

  it("keeps failed and custom tasks separate from full success", () => {
    expect(
      describeOverallTaskResult(
        makeRun({
          presetId: "catalog-cheapest-home",
          evaluation: { status: "failed", reason: "Wrong product." },
        }),
      ),
    ).toMatchObject({
      label: "Task failed",
      tone: "danger",
      fullPass: false,
    });
    expect(
      describeOverallTaskResult(
        makeRun({ evaluation: { status: "not_evaluated", reason: null } }),
      ),
    ).toMatchObject({
      label: "Not evaluated",
      tone: "neutral",
      fullPass: false,
    });
  });

  it("shows a pending evaluation while a preset run is active", () => {
    expect(
      describeOverallTaskResult(
        makeRun({
          presetId: "catalog-cheapest-home",
          status: "running",
          stopReason: null,
          evaluation: { status: "not_evaluated", reason: null },
          uiEvidence: "unverified",
        }),
      ),
    ).toMatchObject({
      label: "Evaluation pending",
      tone: "neutral",
      fullPass: false,
    });
  });

  it("shows the overall block only for preset task runs", () => {
    expect(
      shouldShowOverallTaskResult(
        makeRun({ presetId: "catalog-cheapest-home" }),
      ),
    ).toBe(true);
    expect(shouldShowOverallTaskResult(makeRun({ presetId: null }))).toBe(false);
    expect(
      shouldShowOverallTaskResult(
        makeRun({ kind: "verification", presetId: null }),
      ),
    ).toBe(false);
  });

  it("never describes a custom or verification run as a task result", () => {
    const passed = {
      evaluation: { status: "passed" as const, reason: "Matched." },
      uiEvidence: "observed" as const,
    };
    expect(
      describeOverallTaskResult(makeRun({ ...passed, presetId: null })),
    ).toMatchObject({ label: "Not evaluated", fullPass: false });
    expect(
      describeOverallTaskResult(
        makeRun({ ...passed, kind: "verification", presetId: null }),
      ),
    ).toMatchObject({ label: "Not evaluated", fullPass: false });
  });
});

describe("dashboard view", () => {
  it("selects the active run and the newest run of each kind", () => {
    const active = makeRun({
      runId: "22222222-2222-4222-8222-222222222222",
      kind: "verification",
      status: "running",
      endedAt: null,
    });
    const olderVerification = makeRun({
      runId: "33333333-3333-4333-8333-333333333333",
      kind: "verification",
    });
    const task = makeRun({ runId: "44444444-4444-4444-8444-444444444444" });
    const view = pickAgentDashboardView({
      gate: makeGate(),
      activeRunId: active.runId,
      runs: [active, olderVerification, task],
    });
    expect(view.activeRun?.runId).toBe(active.runId);
    expect(view.latestVerification?.runId).toBe(active.runId);
    expect(view.latestTask?.runId).toBe(task.runId);
  });

  it("has no active run when the holder is idle", () => {
    const view = pickAgentDashboardView({
      gate: makeGate(),
      activeRunId: null,
      runs: [makeRun()],
    });
    expect(view.activeRun).toBeNull();
    expect(view.latestTask).not.toBeNull();
    expect(view.latestVerification).toBeNull();
  });
});
