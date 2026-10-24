import { describe, expect, it } from "vitest";
import { AppConfigError, parseLoopbackOrigin } from "../src/server/config";
import {
  AGENT_RUN_DEFAULT_LIMITS,
  AGENT_WORKER_MAX_EVENTS,
  AGENT_WORKER_MAX_OUTPUT_CHARS,
  AGENT_WORKER_MAX_TASK_CHARS,
  agentCancelMessageSchema,
  agentParentMessageSchema,
  agentStartMessageSchema,
  agentWorkerEventMessageSchema,
  agentWorkerMessageSchema,
  isObservedBrowserToolEvent,
} from "../src/lib/agent-ipc";

const runId = "6f6a1f9e-6a4e-4f3f-9d1a-2b3c4d5e6f70";

function startMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "start",
    runId,
    model: "openrouter/openai/gpt-5.6-luna",
    task: "Read the page heading.",
    startUrl: "http://127.0.0.1:3000",
    limits: { ...AGENT_RUN_DEFAULT_LIMITS },
    headless: false,
    ...overrides,
  };
}

describe("agent run limits", () => {
  it("defaults to the documented 30 steps, 180 seconds, and $1.00", () => {
    expect(AGENT_RUN_DEFAULT_LIMITS).toEqual({
      maxSteps: 30,
      timeoutMs: 180_000,
      maxCostUsd: 1,
    });
  });

  it("rejects out-of-range or non-integer limits", () => {
    for (const limits of [
      { ...AGENT_RUN_DEFAULT_LIMITS, maxSteps: 0 },
      { ...AGENT_RUN_DEFAULT_LIMITS, maxSteps: 201 },
      { ...AGENT_RUN_DEFAULT_LIMITS, maxSteps: 1.5 },
      { ...AGENT_RUN_DEFAULT_LIMITS, timeoutMs: 9_999 },
      { ...AGENT_RUN_DEFAULT_LIMITS, timeoutMs: 1_800_001 },
      { ...AGENT_RUN_DEFAULT_LIMITS, maxCostUsd: 0 },
      { ...AGENT_RUN_DEFAULT_LIMITS, maxCostUsd: 100.01 },
      { ...AGENT_RUN_DEFAULT_LIMITS, maxCostUsd: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        agentStartMessageSchema.safeParse(startMessage({ limits })).success,
      ).toBe(false);
    }
  });
});

describe("agent start messages", () => {
  it("accepts a bounded start message", () => {
    const parsed = agentStartMessageSchema.parse(
      startMessage({ task: "  Read the heading.  ", heartbeatMs: 250 }),
    );
    expect(parsed.task).toBe("Read the heading.");
    expect(parsed.headless).toBe(false);
    expect(parsed.heartbeatMs).toBe(250);
  });

  it("rejects malformed, oversized, and extended messages", () => {
    for (const overrides of [
      { runId: "not-a-uuid" },
      { model: "bad model" },
      { task: "" },
      { task: "x".repeat(AGENT_WORKER_MAX_TASK_CHARS + 1) },
      { startUrl: "" },
      { startUrl: "x".repeat(301) },
      { headless: "yes" },
      { limits: undefined },
      { heartbeatMs: 100 },
      { heartbeatMs: 31_000 },
      { extra: true },
    ]) {
      expect(
        agentStartMessageSchema.safeParse(startMessage(overrides)).success,
      ).toBe(false);
    }
  });

  it("accepts only the documented parent message types", () => {
    expect(agentCancelMessageSchema.safeParse({ type: "cancel" }).success).toBe(
      true,
    );
    expect(
      agentParentMessageSchema.safeParse({ type: "cancel", reason: "stop" })
        .success,
    ).toBe(true);
    expect(
      agentParentMessageSchema.safeParse({ type: "cancel", reason: "x".repeat(201) })
        .success,
    ).toBe(false);
    expect(
      agentParentMessageSchema.safeParse({ type: "stop", runId }).success,
    ).toBe(false);
    expect(agentParentMessageSchema.safeParse(startMessage()).success).toBe(true);
  });
});

describe("loopback start URLs", () => {
  it("accepts loopback origins with an explicit port and labels errors", () => {
    expect(parseLoopbackOrigin("http://127.0.0.1:3000", "The agent start URL"))
      .toMatchObject({ origin: "http://127.0.0.1:3000", hostname: "127.0.0.1" });
    expect(
      parseLoopbackOrigin("http://localhost:4123/", "The agent start URL")
        .hostname,
    ).toBe("localhost");
  });

  it("rejects URLs that are not a plain loopback http origin", () => {
    for (const value of [
      "http://192.168.1.10:3000",
      "http://0.0.0.0:3000",
      "https://127.0.0.1:3000",
      "http://example.com:3000",
      "http://127.0.0.1:3000/shop",
      "http://127.0.0.1:80",
      "http://user:pass@127.0.0.1:3000",
      "",
    ]) {
      expect(() =>
        parseLoopbackOrigin(value, "The agent start URL"),
      ).toThrow(AppConfigError);
    }
    expect(() => parseLoopbackOrigin("http://10.0.0.1:3000", "The agent start URL"))
      .toThrow(/The agent start URL must use the loopback host/);
  });
});

describe("worker messages", () => {
  it("accepts the documented worker message shapes", () => {
    expect(agentWorkerMessageSchema.safeParse({ type: "ready" }).success).toBe(
      true,
    );
    expect(
      agentWorkerMessageSchema.safeParse({
        type: "started",
        runId,
        startedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      agentWorkerMessageSchema.safeParse({
        type: "heartbeat",
        runId,
        at: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      agentWorkerMessageSchema.safeParse({
        type: "event",
        runId,
        seq: 1,
        at: new Date().toISOString(),
        kind: "tool_end",
        toolName: "javascript",
        isError: false,
        imageContent: true,
      }).success,
    ).toBe(true);
    expect(
      agentWorkerMessageSchema.safeParse({
        type: "result",
        runId,
        status: "completed",
        outputText: "{}",
        error: null,
        steps: 3,
        durationMs: 25,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          estimatedCostUsd: 0.01,
        },
        imageInputObserved: false,
      }).success,
    ).toBe(true);
    expect(
      agentWorkerMessageSchema.safeParse({
        type: "error",
        runId: null,
        message: "The browser could not start.",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown kinds, statuses, negative usage, and oversized text", () => {
    const base = {
      type: "event",
      runId,
      seq: 1,
      at: new Date().toISOString(),
      kind: "tool_end",
    };
    expect(
      agentWorkerMessageSchema.safeParse({ ...base, kind: "screenshot" }).success,
    ).toBe(false);
    expect(
      agentWorkerMessageSchema.safeParse({ ...base, seq: 0 }).success,
    ).toBe(false);

    const result = {
      type: "result",
      runId,
      status: "completed",
      outputText: "ok",
      error: null,
      steps: 1,
      durationMs: 1,
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
      },
      imageInputObserved: false,
    };
    expect(agentWorkerMessageSchema.safeParse(result).success).toBe(true);
    expect(
      agentWorkerMessageSchema.safeParse({ ...result, status: "succeeded" })
        .success,
    ).toBe(false);
    expect(
      agentWorkerMessageSchema.safeParse({
        ...result,
        outputText: "x".repeat(AGENT_WORKER_MAX_OUTPUT_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      agentWorkerMessageSchema.safeParse({
        ...result,
        usage: { ...result.usage, inputTokens: -1 },
      }).success,
    ).toBe(false);
    expect(
      agentWorkerMessageSchema.safeParse({ type: "error", runId, message: "" })
        .success,
    ).toBe(false);
  });

  it("bounds the worker event stream", () => {
    expect(AGENT_WORKER_MAX_EVENTS).toBeGreaterThan(0);
    expect(AGENT_WORKER_MAX_EVENTS).toBeLessThanOrEqual(10_000);
  });
});

describe("browser UI evidence", () => {
  const base = {
    type: "event",
    runId,
    seq: 1,
    at: "2026-10-24T10:00:00.000Z",
  };

  it("counts only successful browser JavaScript tool ends", () => {
    const parse = (value: Record<string, unknown>) =>
      agentWorkerEventMessageSchema.parse({ ...base, ...value });

    expect(
      isObservedBrowserToolEvent(
        parse({ kind: "tool_end", toolName: "javascript", isError: false }),
      ),
    ).toBe(true);
    expect(
      isObservedBrowserToolEvent(
        parse({ kind: "tool_end", toolName: "javascript", isError: true }),
      ),
    ).toBe(false);
    expect(
      isObservedBrowserToolEvent(
        parse({ kind: "tool_end", toolName: "javascript" }),
      ),
    ).toBe(false);
    expect(
      isObservedBrowserToolEvent(
        parse({ kind: "tool_start", toolName: "javascript" }),
      ),
    ).toBe(false);
    expect(
      isObservedBrowserToolEvent(
        parse({ kind: "tool_end", toolName: "finish", isError: false }),
      ),
    ).toBe(false);
    expect(
      isObservedBrowserToolEvent(
        parse({ kind: "tool_end", toolName: "finish_from_js", isError: false }),
      ),
    ).toBe(false);
    expect(
      isObservedBrowserToolEvent(parse({ kind: "tool_end", isError: false })),
    ).toBe(false);
  });
});
