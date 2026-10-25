import { describe, expect, it } from "vitest";
import {
  AGENT_WORKER_MAX_EVENTS,
  type AgentWorkerEventMessage,
} from "@/lib/agent-ipc";
import {
  AGENT_TRACE_MAX_EVENTS,
  describeAgentEvent,
  formatTraceTime,
  mergeAgentTrace,
  summarizeAgentTrace,
  type AgentTracePayload,
  type AgentTraceState,
} from "@/lib/agent-trace";
import { pickAgentDashboardView, selectTraceRun } from "@/lib/agent-dashboard-view";
import type { AgentGate } from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function event(
  seq: number,
  kind: AgentWorkerEventMessage["kind"],
  overrides: Partial<AgentWorkerEventMessage> = {},
): AgentWorkerEventMessage {
  return {
    type: "event",
    runId: RUN_ID,
    seq,
    at: `2026-10-24T10:00:0${Math.min(seq, 9)}.000Z`,
    kind,
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 2,
    runId: RUN_ID,
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

function payload(
  events: readonly AgentWorkerEventMessage[],
  overrides: Partial<AgentTracePayload> = {},
): AgentTracePayload {
  return {
    version: 1,
    runId: RUN_ID,
    events,
    truncated: false,
    reset: false,
    ...overrides,
  };
}

describe("agent trace descriptions", () => {
  it("describes every worker event kind without raw payloads", () => {
    expect(describeAgentEvent(event(1, "agent_start")).label).toBe(
      "Agent started",
    );
    expect(describeAgentEvent(event(2, "turn_start")).label).toBe(
      "Model turn started",
    );
    expect(describeAgentEvent(event(3, "turn_end")).label).toBe(
      "Model turn finished",
    );
    expect(
      describeAgentEvent(event(4, "tool_start", { toolName: "javascript" }))
        .label,
    ).toBe("Tool started: javascript");
    expect(
      describeAgentEvent(
        event(5, "tool_end", { toolName: "javascript", isError: true }),
      ),
    ).toMatchObject({ label: "Tool failed: javascript", tone: "danger" });
    expect(
      describeAgentEvent(
        event(6, "tool_end", { toolName: "javascript", imageContent: true }),
      ),
    ).toMatchObject({
      label: "Tool finished: javascript",
      detail: "The result carried image content.",
    });
    expect(describeAgentEvent(event(7, "agent_end")).label).toBe(
      "Agent finished",
    );
  });

  it("treats an HTML-looking tool name as plain text", () => {
    const description = describeAgentEvent(
      event(1, "tool_start", { toolName: "<img src=x onerror=alert(1)>" }),
    );
    expect(description.label).toBe(
      "Tool started: <img src=x onerror=alert(1)>",
    );
  });

  it("summarizes step count, latest action, errors, and image evidence", () => {
    const events = [
      event(1, "agent_start"),
      event(2, "tool_start", { toolName: "javascript" }),
      event(3, "tool_end", { toolName: "javascript", imageContent: true }),
      event(4, "tool_start", { toolName: "javascript" }),
      event(5, "tool_end", { toolName: "javascript", isError: true }),
      event(6, "agent_end"),
    ];
    expect(summarizeAgentTrace(events)).toMatchObject({
      step: 2,
      eventCount: 6,
      toolErrors: 1,
      imageObserved: true,
      latestAction: "Agent finished",
    });
    expect(summarizeAgentTrace([])).toMatchObject({
      step: 0,
      eventCount: 0,
      latestAction: "No browser actions yet.",
    });
  });

  it("formats deterministic UTC clock labels", () => {
    expect(formatTraceTime("2026-10-24T10:00:05.000Z")).toBe("10:00:05Z");
    expect(formatTraceTime("2026-10-24T12:00:05.000+02:00")).toBe(
      "10:00:05Z",
    );
    expect(formatTraceTime("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("keeps the client event cap in sync with the worker cap", () => {
    expect(AGENT_TRACE_MAX_EVENTS).toBe(AGENT_WORKER_MAX_EVENTS);
  });
});

describe("agent trace merging", () => {
  const initial: AgentTraceState = {
    runId: RUN_ID,
    events: [event(1, "agent_start"), event(2, "tool_start")],
    truncated: false,
  };

  it("dedupes by seq and sorts the merged list", () => {
    const merged = mergeAgentTrace(
      initial,
      payload([event(2, "tool_start"), event(3, "tool_end")]),
    );
    expect(merged.events.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("replaces the list on reset and on a different run", () => {
    const reset = mergeAgentTrace(
      initial,
      payload([event(1, "agent_start")], { reset: true }),
    );
    expect(reset.events.map((item) => item.seq)).toEqual([1]);

    const otherRun = "22222222-2222-4222-8222-222222222222";
    const replaced = mergeAgentTrace(initial, {
      version: 1,
      runId: otherRun,
      events: [
        {
          type: "event",
          runId: otherRun,
          seq: 1,
          at: "2026-10-24T10:00:01.000Z",
          kind: "agent_start",
        },
      ],
      truncated: true,
      reset: false,
    });
    expect(replaced.runId).toBe(otherRun);
    expect(replaced.events.map((item) => item.seq)).toEqual([1]);
    expect(replaced.truncated).toBe(true);
  });

  it("ignores events from another run and clears on a null run", () => {
    const merged = mergeAgentTrace(
      initial,
      payload([
        event(3, "tool_end"),
        {
          type: "event",
          runId: "33333333-3333-4333-8333-333333333333",
          seq: 9,
          at: "2026-10-24T10:00:09.000Z",
          kind: "agent_end",
        },
      ]),
    );
    expect(merged.events.map((item) => item.seq)).toEqual([1, 2, 3]);

    expect(
      mergeAgentTrace(initial, {
        version: 1,
        runId: null,
        events: [],
        truncated: false,
        reset: true,
      }),
    ).toEqual({ runId: null, events: [], truncated: false });
  });

  it("caps the retained trace to the worker event limit", () => {
    const many = Array.from(
      { length: AGENT_TRACE_MAX_EVENTS + 5 },
      (_, index) => event(index + 1, "turn_start"),
    );
    const merged = mergeAgentTrace(
      { runId: null, events: [], truncated: false },
      payload(many, { reset: true }),
    );
    expect(merged.events).toHaveLength(AGENT_TRACE_MAX_EVENTS);
    expect(merged.events[0]?.seq).toBe(6);
  });
});

describe("trace run selection", () => {
  it("follows the active task and otherwise the latest task", () => {
    const activeTask = makeRun({
      runId: "44444444-4444-4444-8444-444444444444",
      status: "running",
      endedAt: null,
    });
    const latestTask = makeRun({
      runId: "55555555-5555-4555-8555-555555555555",
    });
    const view = pickAgentDashboardView({
      gate: makeGate(),
      activeRunId: activeTask.runId,
      runs: [activeTask, latestTask],
    });
    expect(selectTraceRun(view)?.runId).toBe(activeTask.runId);

    const idleView = pickAgentDashboardView({
      gate: makeGate(),
      activeRunId: null,
      runs: [latestTask],
    });
    expect(selectTraceRun(idleView)?.runId).toBe(latestTask.runId);

    const verificationActive = makeRun({
      runId: "66666666-6666-4666-8666-666666666666",
      kind: "verification",
      status: "running",
      endedAt: null,
    });
    const verificationView = pickAgentDashboardView({
      gate: makeGate(),
      activeRunId: verificationActive.runId,
      runs: [verificationActive, latestTask],
    });
    expect(selectTraceRun(verificationView)?.runId).toBe(latestTask.runId);
    expect(
      selectTraceRun(
        pickAgentDashboardView({
          gate: makeGate(),
          activeRunId: verificationActive.runId,
          runs: [verificationActive],
        }),
      ),
    ).toBeNull();
  });

  it("does not fall back to an older task when the active record is missing", () => {
    const latestTask = makeRun({
      runId: "77777777-7777-4777-8777-777777777777",
    });
    const view = pickAgentDashboardView({
      gate: makeGate(),
      activeRunId: "88888888-8888-4888-8888-888888888888",
      runs: [latestTask],
    });
    expect(view.activeRun).toBeNull();
    expect(selectTraceRun(view)).toBeNull();
  });
});
