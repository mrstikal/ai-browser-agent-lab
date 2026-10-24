import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_VERSION,
  AgentRunCorruptionError,
  agentRunFileSegments,
  isActiveAgentRunStatus,
  isTerminalAgentRunStatus,
  loadAgentRun,
  parseAgentRunRecord,
  saveAgentRun,
  type AgentRunRecord,
} from "../src/server/agent-runs";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-runs-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function phase24Record(runId: string): Record<string, unknown> {
  const timestamp = "2026-10-24T00:00:00.000Z";
  return {
    version: 1,
    runId,
    kind: "verification",
    task: "Open http://127.0.0.1:3000/shop using only the visible local UI.",
    modelId: "openrouter/openai/gpt-5.6-luna",
    origin: "http://127.0.0.1:3000",
    limits: { maxSteps: 8, timeoutMs: 120_000, maxCostUsd: 0.25 },
    status: "completed",
    stopReason: "completed",
    startedAt: timestamp,
    endedAt: timestamp,
    updatedAt: timestamp,
    steps: 3,
    durationMs: 25,
    outputText: '{"heading":"Shop"}',
    error: null,
    usage: null,
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "not_evaluated", reason: null },
    uiEvidence: "unverified",
    worker: null,
    eventCount: 0,
    lastSeq: 0,
  };
}

describe("agent run records", () => {
  it("loads a version 1 record and normalizes the cancellation fields", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    await storage.writeJson(
      agentRunFileSegments(runId),
      phase24Record(runId),
    );

    const record = await loadAgentRun(storage, runId);
    expect(record).toMatchObject({
      version: AGENT_RUN_VERSION,
      runId,
      status: "completed",
      cancelRequestedAt: null,
      cancelReason: null,
      watchdogExpiredAt: null,
    });
  });

  it("writes version 2 records with every cancellation field present", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const record = parseAgentRunRecord(phase24Record(runId));
    expect(record.version).toBe(AGENT_RUN_VERSION);
    record.cancelRequestedAt = "2026-10-24T00:00:05.000Z";
    record.cancelReason = "watchdog";
    await saveAgentRun(storage, record);

    const stored = (await storage.readJson<Record<string, unknown>>(
      agentRunFileSegments(runId),
    )) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 2,
      cancelRequestedAt: "2026-10-24T00:00:05.000Z",
      cancelReason: "watchdog",
      watchdogExpiredAt: null,
    });

    const loaded = await loadAgentRun(storage, runId);
    expect(loaded).toMatchObject({
      version: 2,
      cancelReason: "watchdog",
      cancelRequestedAt: "2026-10-24T00:00:05.000Z",
    });
  });

  it("requires the cancellation fields for version 2 records", () => {
    const runId = randomUUID();
    const v2WithoutCancellation = {
      ...phase24Record(runId),
      version: 2,
    };
    expect(() => parseAgentRunRecord(v2WithoutCancellation)).toThrow(
      AgentRunCorruptionError,
    );
    expect(() =>
      parseAgentRunRecord({
        ...v2WithoutCancellation,
        cancelRequestedAt: null,
        cancelReason: null,
        watchdogExpiredAt: null,
      }),
    ).not.toThrow();
  });

  it("rejects unknown versions, statuses, and malformed snapshots", () => {
    const runId = randomUUID();
    expect(() =>
      parseAgentRunRecord({ ...phase24Record(runId), version: 3 }),
    ).toThrow(AgentRunCorruptionError);
    expect(() =>
      parseAgentRunRecord({ ...phase24Record(runId), status: "succeeded" }),
    ).toThrow(AgentRunCorruptionError);
    expect(() =>
      parseAgentRunRecord({ ...phase24Record(runId), cancelReason: "robot" }),
    ).toThrow(AgentRunCorruptionError);
    expect(() =>
      parseAgentRunRecord({ ...phase24Record(runId), unexpected: true }),
    ).toThrow(AgentRunCorruptionError);
  });

  it("separates active from terminal lifecycle statuses", () => {
    expect(agentRunLifecycleCase("running")).toBe("active");
    expect(agentRunLifecycleCase("cancelling")).toBe("active");
    expect(agentRunLifecycleCase("hung")).toBe("active");
    expect(agentRunLifecycleCase("completed")).toBe("terminal");
    expect(agentRunLifecycleCase("failed")).toBe("terminal");
  });
});

function agentRunLifecycleCase(
  status: AgentRunRecord["status"],
): "active" | "terminal" | "unknown" {
  if (isActiveAgentRunStatus(status)) return "active";
  if (isTerminalAgentRunStatus(status)) return "terminal";
  return "unknown";
}
