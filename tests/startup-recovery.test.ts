import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAgentRun,
  saveAgentRun,
  type AgentRunRecord,
} from "../src/server/agent-runs";
import { runStartupRecoveries } from "../src/server/startup";
import { AGENT_RUN_LOCK_KIND, PAID_JOB_LOCK_SEGMENTS } from "../src/server/paid-lock";
import { readBootId } from "../src/server/process-identity";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-startup-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function orphanRun(
  runId: string,
  workerPid: number,
  bootId: string,
): AgentRunRecord {
  const timestamp = new Date().toISOString();
  return {
    version: 2,
    runId,
    kind: "task",
    presetId: null,
    formBaseline: null,
    task: "Read the main heading.",
    modelId: "openrouter/openai/gpt-5.6-luna",
    origin: "http://127.0.0.1:3000",
    limits: { maxSteps: 30, timeoutMs: 180_000, maxCostUsd: 1 },
    status: "running",
    stopReason: null,
    startedAt: timestamp,
    endedAt: null,
    updatedAt: timestamp,
    steps: null,
    durationMs: null,
    outputText: null,
    error: null,
    usage: null,
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "not_evaluated", reason: null },
    uiEvidence: "unverified",
    worker: {
      pid: workerPid,
      groupId: workerPid,
      procStartTicks: 1,
      bootId,
    },
    eventCount: 0,
    lastSeq: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
  };
}

describe("startup recovery wiring", () => {
  it("reconciles agent runs before image recovery and releases the stale lock", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const deadWorkerPid = 999_999;
    const bootId = await readBootId();
    await saveAgentRun(storage, orphanRun(runId, deadWorkerPid, bootId));
    await storage.writeFile(
      PAID_JOB_LOCK_SEGMENTS,
      `${JSON.stringify(
        {
          version: 1,
          kind: AGENT_RUN_LOCK_KIND,
          ownerId: runId,
          pid: deadWorkerPid,
          procStartTicks: 1,
          bootId,
          acquiredAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runStartupRecoveries(storage);

    const lines = log.mock.calls.map((call) => String(call[0]));
    const agentIndex = lines.findIndex((line) => line.includes("agent recovery:"));
    const imageIndex = lines.findIndex((line) => line.includes("image recovery"));
    expect(agentIndex).toBeGreaterThanOrEqual(0);
    expect(imageIndex).toBeGreaterThan(agentIndex);

    const recovered = await loadAgentRun(storage, runId);
    expect(recovered?.status).toBe("interrupted");
    expect(
      await storage.readJson<unknown>(PAID_JOB_LOCK_SEGMENTS),
    ).toBeUndefined();
  });

  it("keeps starting when nothing needs recovery", async () => {
    const storage = await makeStorage();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runStartupRecoveries(storage)).resolves.toBeUndefined();

    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("agent recovery skipped"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("image recovery"))).toBe(true);
  });
});
