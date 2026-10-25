import { describe, expect, it } from "vitest";
import {
  AGENT_HISTORY_ERROR_SUMMARY_MAX_CHARS,
  AGENT_HISTORY_LIMIT,
  buildAgentHistory,
  mergeAgentRunSummary,
  toAgentRunSummary,
} from "@/lib/agent-history";
import { AGENT_RUN_LIST_LIMIT, type AgentRunRecord } from "@/server/agent-runs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 2,
    runId: RUN_ID,
    kind: "task",
    presetId: null,
    uiMode: null,
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
    eventCount: 5,
    lastSeq: 5,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
    ...overrides,
  };
}

describe("agent history summaries", () => {
  it("keeps the client history cap in sync with the persisted list cap", () => {
    expect(AGENT_HISTORY_LIMIT).toBe(AGENT_RUN_LIST_LIMIT);
  });

  it("projects bounded fields without task text, output, or worker data", () => {
    const longError = `${"The worker failed. ".repeat(30)}`;
    const summary = toAgentRunSummary(
      makeRun({
        uiMode: "classic",
        error: longError,
        formBaseline: {
          form: "support",
          submissionIds: ["66666666-6666-4666-8666-666666666666"],
        },
        worker: {
          pid: 123,
          groupId: 123,
          procStartTicks: 456,
          bootId: "boot",
        },
      }),
    );
    expect(summary).toMatchObject({
      runId: RUN_ID,
      modelId: "openrouter/openai/gpt-5.6-luna",
      status: "completed",
      stopReason: "completed",
      steps: 3,
      durationMs: 5_000,
      uiMode: "classic",
      uiEvidence: "unverified",
      vision: "unverified",
    });
    expect(summary.errorSummary).not.toBeNull();
    expect(summary.errorSummary?.length).toBeLessThanOrEqual(
      AGENT_HISTORY_ERROR_SUMMARY_MAX_CHARS,
    );
    expect(summary.errorSummary?.endsWith("…")).toBe(true);
    for (const excluded of [
      "task",
      "outputText",
      "error",
      "formBaseline",
      "worker",
      "origin",
      "limits",
    ]) {
      expect(summary).not.toHaveProperty(excluded);
    }
  });

  it("keeps history newest first and capped", () => {
    const runs = Array.from({ length: AGENT_HISTORY_LIMIT + 5 }, (_, index) =>
      makeRun({
        runId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        startedAt: new Date(
          Date.parse("2026-10-24T00:00:00.000Z") + index * 1_000,
        ).toISOString(),
      }),
    );
    const history = buildAgentHistory(runs);
    expect(history).toHaveLength(AGENT_HISTORY_LIMIT);
    expect(history[0]?.startedAt).toBe(
      new Date(
        Date.parse("2026-10-24T00:00:00.000Z") +
          (AGENT_HISTORY_LIMIT + 4) * 1_000,
      ).toISOString(),
    );
    expect(history.at(-1)?.startedAt).toBe(
      new Date(Date.parse("2026-10-24T00:00:00.000Z") + 5 * 1_000).toISOString(),
    );
  });

  it("replaces an updated run in place without duplicating it", () => {
    const older = makeRun({
      runId: "22222222-2222-4222-8222-222222222222",
      startedAt: "2026-10-24T09:00:00.000Z",
    });
    const current = makeRun();
    const history = buildAgentHistory([older, current]);
    const updated = makeRun({ stopReason: "cancelled" });
    const merged = mergeAgentRunSummary(history, updated);
    expect(merged).toHaveLength(2);
    expect(merged.map((run) => run.runId)).toEqual([current.runId, older.runId]);
    expect(merged[0]).toMatchObject({
      status: "completed",
      stopReason: "cancelled",
    });
  });
});
