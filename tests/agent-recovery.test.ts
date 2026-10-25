import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_RECOVERY_FILE,
  AGENT_RECOVERY_VERSION,
  loadAgentRecoveryReport,
  recoverInterruptedAgentState,
} from "../src/server/agent-recovery";
import {
  loadAgentRun,
  saveAgentRun,
  type AgentRunRecord,
  type AgentRunWorker,
} from "../src/server/agent-runs";
import {
  AGENT_RUN_LOCK_KIND,
  PAID_JOB_LOCK_SEGMENTS,
} from "../src/server/paid-lock";
import { readBootId, readProcessStartTicks } from "../src/server/process-identity";
import { Storage } from "../src/server/storage";

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

const FAST_GRACES = { sigtermGraceMs: 100, sigkillGraceMs: 100 };

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-recovery-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function runRecord(
  overrides: Partial<AgentRunRecord> & { runId: string },
): AgentRunRecord {
  const timestamp = new Date().toISOString();
  const base: AgentRunRecord = {
    version: 2,
    runId: overrides.runId,
    kind: "task",
    presetId: null,
    uiMode: null,
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
    worker: null,
    eventCount: 0,
    lastSeq: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
  };
  return { ...base, ...overrides };
}

async function writeStaleLock(storage: Storage, runId: string): Promise<void> {
  const bootId = await readBootId();
  await storage.writeFile(
    PAID_JOB_LOCK_SEGMENTS,
    `${JSON.stringify(
      {
        version: 1,
        kind: AGENT_RUN_LOCK_KIND,
        ownerId: runId,
        pid: 999_999,
        procStartTicks: 1,
        bootId,
        acquiredAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function spawnOrphan(profileDir: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    argv0: `--user-data-dir=${profileDir}`,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  children.push(child);
  return child;
}

async function identityOf(pid: number, groupId: number): Promise<AgentRunWorker> {
  const [ticks, bootId] = await Promise.all([
    readProcessStartTicks(pid),
    readBootId(),
  ]);
  if (ticks === undefined) throw new Error(`Process ${pid} is not running.`);
  return { pid, groupId, procStartTicks: ticks, bootId };
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readProcessStartTicks(pid)) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} did not exit.`);
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.pid === undefined) throw new Error("Missing pid.");
  await waitForExit(child.pid);
  return child.pid;
}

describe("agent restart recovery", () => {
  it("marks an orphan run interrupted and releases the stale lock once the group is gone", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const gonePid = await deadPid();
    await saveAgentRun(
      storage,
      runRecord({
        runId,
        status: "hung",
        watchdogExpiredAt: new Date().toISOString(),
        worker: {
          pid: gonePid,
          groupId: gonePid,
          procStartTicks: 1,
          bootId: await readBootId(),
        },
      }),
    );
    await writeStaleLock(storage, runId);

    const report = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });

    expect(report.status).toBe("reconciled");
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      runId,
      previousStatus: "hung",
      outcome: "already-gone",
      lock: "released",
    });
    const run = await loadAgentRun(storage, runId);
    expect(run).toMatchObject({ status: "interrupted" });
    expect(run?.endedAt).not.toBeNull();
    expect(run?.error).toContain("app restarted");
    const persisted = await loadAgentRecoveryReport(storage);
    expect(persisted).toMatchObject({ status: "reconciled" });
    expect(
      await storage.readJson<unknown>(PAID_JOB_LOCK_SEGMENTS),
    ).toBeUndefined();
  });

  it("evaluates a preset task interrupted by restart as failed", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const gonePid = await deadPid();
    await saveAgentRun(
      storage,
      runRecord({
        runId,
        presetId: "catalog-cheapest-home",
        status: "hung",
        watchdogExpiredAt: new Date().toISOString(),
        worker: {
          pid: gonePid,
          groupId: gonePid,
          procStartTicks: 1,
          bootId: await readBootId(),
        },
      }),
    );
    await writeStaleLock(storage, runId);

    await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });

    const run = await loadAgentRun(storage, runId);
    expect(run).toMatchObject({
      status: "interrupted",
      presetId: "catalog-cheapest-home",
      evaluation: { status: "failed" },
    });
    expect(run?.evaluation.reason).toContain("app restarted");
  });

  it("backfills evaluation for a previously unresolved terminal preset run", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const gonePid = await deadPid();
    const timestamp = new Date().toISOString();
    await saveAgentRun(
      storage,
      runRecord({
        runId,
        presetId: "catalog-cheapest-home",
        status: "interrupted",
        error: "The app restarted before the worker group was proven gone.",
        endedAt: timestamp,
        worker: {
          pid: gonePid,
          groupId: gonePid,
          procStartTicks: 1,
          bootId: await readBootId(),
        },
      }),
    );
    await storage.writeJson([AGENT_RECOVERY_FILE], {
      version: AGENT_RECOVERY_VERSION,
      finishedAt: timestamp,
      status: "reconciled",
      corruptRuns: 0,
      runs: [
        {
          runId,
          previousStatus: "interrupted",
          outcome: "skipped",
          reason: "unverifiable",
          signals: [],
          memberPids: [],
          remainingPids: [],
          lock: "held",
          message: "Manual cleanup is required.",
        },
      ],
    });
    await writeStaleLock(storage, runId);

    const report = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });
    expect(report.runs[0]).toMatchObject({
      runId,
      outcome: "already-gone",
      lock: "released",
    });
    const run = await loadAgentRun(storage, runId);
    expect(run).toMatchObject({
      status: "interrupted",
      presetId: "catalog-cheapest-home",
      evaluation: { status: "failed" },
    });
  });

  it("recovers a completed run whose worker was still closing at crash time", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const profileDir = storage.path(["browser-profiles", runId]);
    const orphan = spawnOrphan(profileDir);
    const pid = orphan.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    await saveAgentRun(
      storage,
      runRecord({
        runId,
        status: "completed",
        stopReason: "completed",
        endedAt: new Date().toISOString(),
        worker: await identityOf(pid, pid),
      }),
    );
    await writeStaleLock(storage, runId);

    const report = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });
    expect(report.runs[0]).toMatchObject({
      runId,
      previousStatus: "completed",
      outcome: "terminated",
      lock: "released",
    });
    await waitForExit(pid);
    expect(
      await storage.readJson<unknown>(PAID_JOB_LOCK_SEGMENTS),
    ).toBeUndefined();
    const run = await loadAgentRun(storage, runId);
    expect(run?.status).toBe("completed");
  });

  it("terminates a live orphan group before releasing the lock", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const profileDir = storage.path(["browser-profiles", runId]);
    const orphan = spawnOrphan(profileDir);
    const pid = orphan.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    await saveAgentRun(
      storage,
      runRecord({
        runId,
        worker: await identityOf(pid, pid),
      }),
    );
    await writeStaleLock(storage, runId);

    const report = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });

    expect(report.runs[0]).toMatchObject({
      runId,
      outcome: "terminated",
      lock: "released",
      signals: ["SIGTERM"],
    });
    await waitForExit(pid);
    const run = await loadAgentRun(storage, runId);
    expect(run).toMatchObject({ status: "interrupted" });
    expect(run?.error).toContain("terminated");
    expect(
      await storage.readJson<unknown>(PAID_JOB_LOCK_SEGMENTS),
    ).toBeUndefined();
  });

  it("keeps the lock and reports an uncertain group instead of signaling it", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    stranger.unref();
    children.push(stranger);
    const strangerPid = stranger.pid ?? 0;
    await saveAgentRun(
      storage,
      runRecord({
        runId,
        worker: {
          pid: await deadPid(),
          groupId: strangerPid,
          procStartTicks: 1,
          bootId: await readBootId(),
        },
      }),
    );
    await writeStaleLock(storage, runId);

    const report = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });

    expect(report.runs[0]).toMatchObject({
      runId,
      outcome: "skipped",
      reason: "not-owned",
      lock: "held",
    });
    expect(report.runs[0]?.memberPids).toContain(strangerPid);
    const run = await loadAgentRun(storage, runId);
    expect(run).toMatchObject({ status: "interrupted" });
    expect(run?.error).toContain("manual cleanup");
    // The stranger keeps running and the paid lock is reclaimed under this
    // live process so it genuinely blocks until manual cleanup.
    expect(await readProcessStartTicks(strangerPid)).toBeDefined();
    const held = await storage.readJson<{
      pid: number;
      kind: string;
      ownerId: string;
    }>(PAID_JOB_LOCK_SEGMENTS);
    expect(held).toMatchObject({ kind: AGENT_RUN_LOCK_KIND, ownerId: runId });
    expect(held?.pid).toBe(process.pid);
  });

  it("keeps the barrier across restarts and clears it once the group is gone", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    stranger.unref();
    children.push(stranger);
    const strangerPid = stranger.pid ?? 0;
    await saveAgentRun(
      storage,
      runRecord({
        runId,
        worker: {
          pid: await deadPid(),
          groupId: strangerPid,
          procStartTicks: 1,
          bootId: await readBootId(),
        },
      }),
    );
    await writeStaleLock(storage, runId);

    const first = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });
    expect(first.runs[0]).toMatchObject({ outcome: "skipped", lock: "held" });
    // The barrier file itself persists; it is owned by this process now.
    expect(
      await storage.readJson<{ pid: number }>(PAID_JOB_LOCK_SEGMENTS),
    ).toMatchObject({ pid: process.pid });

    // Model the holding process dying: the persisted file keeps its metadata
    // but the recorded owner is gone.
    await writeStaleLock(storage, runId);
    const second = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });
    expect(second.runs[0]).toMatchObject({
      runId,
      outcome: "skipped",
      lock: "held",
    });
    expect(
      await storage.readJson<{ pid: number }>(PAID_JOB_LOCK_SEGMENTS),
    ).toMatchObject({ pid: process.pid });

    // Even when the barrier file was removed manually, an unresolved group
    // recreates it instead of reporting a cosmetic "absent".
    await storage.deleteFile(PAID_JOB_LOCK_SEGMENTS);
    const third = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });
    expect(third.runs[0]).toMatchObject({ outcome: "skipped", lock: "held" });
    expect(
      await storage.readJson<{ pid: number }>(PAID_JOB_LOCK_SEGMENTS),
    ).toMatchObject({ pid: process.pid });

    // Manual cleanup happens; the next boot must clear the barrier.
    process.kill(strangerPid, "SIGKILL");
    await waitForExit(strangerPid);
    await writeStaleLock(storage, runId);
    const fourth = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });
    expect(fourth.runs[0]).toMatchObject({
      runId,
      outcome: "already-gone",
      lock: "released",
    });
    expect(
      await storage.readJson<unknown>(PAID_JOB_LOCK_SEGMENTS),
    ).toBeUndefined();
    const run = await loadAgentRun(storage, runId);
    expect(run?.error).toContain("no longer needed");
  });

  it("reports unreadable run records even when nothing is active", async () => {
    const storage = await makeStorage();
    const corruptName = `${randomUUID()}.json`;
    await storage.writeFile(
      ["agent-runs", corruptName],
      "{ this is not JSON\n",
    );

    const report = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });

    expect(report).toMatchObject({ status: "skipped", corruptRuns: 1, runs: [] });
    expect(await loadAgentRecoveryReport(storage)).toMatchObject({
      corruptRuns: 1,
    });
    // The corrupt file is preserved for manual inspection.
    expect(await storage.readFile(["agent-runs", corruptName])).toBeDefined();
  });

  it("does nothing and writes no report when no run is active", async () => {
    const storage = await makeStorage();
    const runId = randomUUID();
    await saveAgentRun(
      storage,
      runRecord({ runId, status: "completed", stopReason: "completed" }),
    );

    const report = await recoverInterruptedAgentState({
      storage,
      ...FAST_GRACES,
    });

    expect(report).toEqual({
      version: 1,
      finishedAt: report.finishedAt,
      status: "skipped",
      corruptRuns: 0,
      runs: [],
    });
    expect(
      await storage.readJson<unknown>([AGENT_RECOVERY_FILE]),
    ).toBeUndefined();
  });
});
