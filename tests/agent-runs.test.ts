import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_LIST_LIMIT,
  AGENT_RUN_VERSION,
  AgentRunCorruptionError,
  agentRunFileSegments,
  isActiveAgentRunStatus,
  isTerminalAgentRunStatus,
  listAgentRuns,
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
      uiMode: null,
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
      uiMode: null,
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

  it("normalizes a missing preset ID and rejects unknown presets", () => {
    const runId = randomUUID();
    const v2 = {
      ...phase24Record(runId),
      version: 2,
      cancelRequestedAt: null,
      cancelReason: null,
      watchdogExpiredAt: null,
    };
    expect(parseAgentRunRecord(v2).presetId).toBeNull();
    expect(parseAgentRunRecord(v2).formBaseline).toBeNull();
    expect(parseAgentRunRecord(v2).uiMode).toBeNull();
    expect(
      parseAgentRunRecord({ ...v2, presetId: "catalog-out-of-stock" }).presetId,
    ).toBe("catalog-out-of-stock");
    expect(
      parseAgentRunRecord({ ...v2, presetId: "form-support-request" }).presetId,
    ).toBe("form-support-request");
    expect(
      parseAgentRunRecord({
        ...v2,
        formBaseline: {
          form: "support",
          submissionIds: ["66666666-6666-4666-8666-666666666666"],
        },
      }).formBaseline,
    ).toEqual({
      form: "support",
      submissionIds: ["66666666-6666-4666-8666-666666666666"],
    });
    expect(parseAgentRunRecord({ ...v2, uiMode: "classic" }).uiMode).toBe(
      "classic",
    );
    expect(parseAgentRunRecord({ ...v2, uiMode: "alternate" }).uiMode).toBe(
      "alternate",
    );
    expect(() =>
      parseAgentRunRecord({ ...v2, uiMode: "fancy" }),
    ).toThrow(AgentRunCorruptionError);
    expect(() =>
      parseAgentRunRecord({ ...v2, presetId: "catalog-unknown" }),
    ).toThrow(AgentRunCorruptionError);
    expect(() =>
      parseAgentRunRecord({
        ...v2,
        formBaseline: { form: "other", submissionIds: [] },
      }),
    ).toThrow(AgentRunCorruptionError);
  });

  it("accepts a legacy form baseline above the capture cap", () => {
    const runId = randomUUID();
    const submissionIds = Array.from(
      { length: 1_001 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const parsed = parseAgentRunRecord({
      ...phase24Record(runId),
      version: 2,
      presetId: "form-support-request",
      formBaseline: { form: "support", submissionIds },
      cancelRequestedAt: null,
      cancelReason: null,
      watchdogExpiredAt: null,
    });
    expect(parsed.formBaseline?.submissionIds).toHaveLength(1_001);
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

  it("retains a bounded newest-first history after reopening storage", async () => {
    const storage = await makeStorage();
    const baseTime = Date.parse("2026-10-24T00:00:00.000Z");
    for (let index = 0; index < AGENT_RUN_LIST_LIMIT + 5; index += 1) {
      const runId = randomUUID();
      const startedAt = new Date(baseTime + index * 1_000).toISOString();
      const record = parseAgentRunRecord({
        ...phase24Record(runId),
        version: 2,
        cancelRequestedAt: null,
        cancelReason: null,
        watchdogExpiredAt: null,
        startedAt,
        endedAt: startedAt,
        updatedAt: startedAt,
      });
      await saveAgentRun(storage, record);
    }

    const reopened = new Storage(storage.root);
    const listed = await listAgentRuns(reopened);
    expect(listed.corrupt).toBe(0);
    expect(listed.runs).toHaveLength(AGENT_RUN_LIST_LIMIT);
    expect(listed.runs[0]?.startedAt).toBe(
      new Date(baseTime + (AGENT_RUN_LIST_LIMIT + 4) * 1_000).toISOString(),
    );
    expect(listed.runs.at(-1)?.startedAt).toBe(
      new Date(baseTime + 5 * 1_000).toISOString(),
    );
    expect((await listAgentRuns(reopened, 10)).runs).toHaveLength(10);
  });

  it("separates active from terminal lifecycle statuses", () => {
    expect(agentRunLifecycleCase("running")).toBe("active");
    expect(agentRunLifecycleCase("cancelling")).toBe("active");
    expect(agentRunLifecycleCase("hung")).toBe("active");
    expect(agentRunLifecycleCase("completed")).toBe("terminal");
    expect(agentRunLifecycleCase("failed")).toBe("terminal");
    expect(agentRunLifecycleCase("interrupted")).toBe("terminal");
  });
});

function agentRunLifecycleCase(
  status: AgentRunRecord["status"],
): "active" | "terminal" | "unknown" {
  if (isActiveAgentRunStatus(status)) return "active";
  if (isTerminalAgentRunStatus(status)) return "terminal";
  return "unknown";
}
