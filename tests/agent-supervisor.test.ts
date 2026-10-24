import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_DEFAULT_LIMITS,
  AGENT_WORKER_MAX_EVENTS,
  type AgentRunLimits,
} from "../src/lib/agent-ipc";
import { HEALTH_MARKER } from "../src/lib/health";
import { saveAgentCompatibility } from "../src/server/agent-compatibility";
import {
  AGENT_CANCEL_GRACE_MS,
  AGENT_VERIFICATION_LIMITS,
  AGENT_WATCHDOG_MARGIN_MS,
  AgentWorkerUnavailableError,
  buildAgentWorkerCommand,
  buildVerificationTask,
  cancelAgentRun,
  getActiveAgentRunId,
  loadAgentStatus,
  readInstalledSdkVersion,
  resetAgentSupervisorForTests,
  resolveAgentWorkerPath,
  startAgentRun,
} from "../src/server/agent-manager";
import {
  isTerminalAgentRunStatus,
  listAgentRuns,
  loadAgentEvents,
  loadAgentRun,
  saveAgentRun,
  type AgentRunRecord,
} from "../src/server/agent-runs";
import {
  deleteOpenRouterKey,
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "../src/server/credentials";
import { acquireLock, LockHeldError, readLockMetadata } from "../src/server/lock";
import { DEFAULT_BROWSER_MODEL_ID } from "../src/server/model-settings";
import {
  AGENT_RUN_LOCK_KIND,
  PAID_JOB_LOCK_KIND,
  PAID_JOB_LOCK_SEGMENTS,
} from "../src/server/paid-lock";
import {
  beginPaidOperation,
  endPaidOperation,
  isPaidOperationActive,
  PaidOperationActiveError,
  resetPaidOperationsForTests,
} from "../src/server/paid-operation";
import {
  readBootId,
  readProcessGroupId,
  readProcessStartTicks,
} from "../src/server/process-identity";
import { createStorage, type Storage } from "../src/server/storage";

const TEST_KEY = "supervisor-test-secret-key-77";
const fakeSdkUrl = new URL(
  "./fixtures/fake-agent-worker-sdk.mjs",
  import.meta.url,
).href;

const tempDirs: string[] = [];
const servers: Server[] = [];

interface TestContext {
  readonly dataDir: string;
  readonly markersDir: string;
  readonly origin: string;
  readonly env: Record<string, string>;
  readonly storage: Storage;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function startHealthServer(
  marker: string = HEALTH_MARKER,
  status = 200,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: status === 200, app: marker }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closedOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", () => resolvePromise()),
  );
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  );
  return `http://127.0.0.1:${address.port}`;
}

async function makeContext(
  mode: string,
  options: { readonly origin?: string } = {},
): Promise<TestContext> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-supervisor-"));
  tempDirs.push(base);
  const origin = options.origin ?? (await startHealthServer()).origin;
  const env: Record<string, string> = {
    DATA_DIR: join(base, "data"),
    LAB_TEST_MODE: "1",
    APP_ORIGIN: origin,
    AGENT_WORKER_TEST_SDK: fakeSdkUrl,
    AGENT_WORKER_FAKE_MODE: mode,
    AGENT_WORKER_TEST_MARKERS: join(base, "markers"),
  };
  const storage = createStorage(env);
  return {
    dataDir: env.DATA_DIR ?? "",
    markersDir: env.AGENT_WORKER_TEST_MARKERS ?? "",
    origin,
    env,
    storage,
  };
}

async function seedKey(context: TestContext): Promise<void> {
  await setOpenRouterKey(TEST_KEY, {
    remember: false,
    env: context.env,
    storage: context.storage,
  });
}

async function seedStamp(
  context: TestContext,
  overrides: { readonly modelId?: string; readonly origin?: string } = {},
): Promise<void> {
  await saveAgentCompatibility(context.storage, {
    version: 1,
    modelId: overrides.modelId ?? DEFAULT_BROWSER_MODEL_ID,
    sdkVersion: await readInstalledSdkVersion(),
    origin: overrides.origin ?? context.origin,
    verifiedAt: new Date().toISOString(),
    vision: "unverified",
  });
}

async function waitForTerminal(
  storage: Storage,
  runId: string,
  timeoutMs = 20_000,
): Promise<AgentRunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await loadAgentRun(storage, runId);
    if (record && isTerminalAgentRunStatus(record.status)) return record;
    await sleep(25);
  }
  throw new Error("Timed out waiting for the mocked agent run to finish.");
}

async function waitForRunStatus(
  storage: Storage,
  runId: string,
  expected: AgentRunRecord["status"],
  timeoutMs = 5_000,
): Promise<AgentRunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await loadAgentRun(storage, runId);
    if (record?.status === expected) return record;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for run status ${expected}.`);
}

async function readMarker<T>(markersDir: string, name: string): Promise<T> {
  return JSON.parse(await readFile(join(markersDir, name), "utf8")) as T;
}

/** Fake-timer safe record polling (setImmediate and Date stay real). */
async function waitForRecord(
  storage: Storage,
  runId: string,
  predicate: (record: AgentRunRecord) => boolean,
  timeoutMs = 10_000,
): Promise<AgentRunRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await loadAgentRun(storage, runId);
    if (record && predicate(record)) return record;
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the agent run record state.");
    }
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
}

async function waitForMarkerFile(
  markersDir: string,
  name: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(join(markersDir, name))) return;
    // Fake-timer safe: setImmediate and Date stay real in these tests.
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(`Timed out waiting for the worker marker ${name}.`);
}

async function waitForIdle(storage: Storage, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readLockMetadata(
      storage.path(PAID_JOB_LOCK_SEGMENTS),
    ).catch(() => null);
    if (!lock && getActiveAgentRunId(storage.root) === null) return;
    await sleep(25);
  }
  throw new Error("Timed out waiting for the agent supervisor to release its run.");
}

async function runFileNames(storage: Storage): Promise<string[]> {
  return storage.listFiles(["agent-runs"]).catch(() => []);
}

beforeEach(() => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  resetAgentSupervisorForTests();
});

afterEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  resetAgentSupervisorForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) =>
          server.close(() => resolvePromise()),
        ),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("agent supervisor", () => {
  it(
    "starts one mocked run, records ownership, and keeps a bounded trace",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("slow");
      await seedKey(context);
      await seedStamp(context);

      const started = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      const run = started.run;

      expect(run).toMatchObject({
        status: "running",
        kind: "task",
        task: "Read the main heading.",
        modelId: DEFAULT_BROWSER_MODEL_ID,
        origin: context.origin,
        limits: AGENT_RUN_DEFAULT_LIMITS,
        stopReason: null,
        steps: null,
        durationMs: null,
        outputText: null,
        error: null,
        usage: null,
        imageInputObserved: false,
        vision: "unverified",
        evaluation: { status: "not_evaluated", reason: null },
        uiEvidence: "unverified",
        eventCount: 0,
        lastSeq: 0,
      });
      expect(run.worker?.pid).toBeGreaterThan(0);
      expect(run.worker?.groupId).toBe(run.worker?.pid);
      const pid = run.worker?.pid ?? 0;
      expect(await readProcessGroupId(pid)).toBe(pid);
      expect(await readProcessStartTicks(pid)).toBe(run.worker?.procStartTicks);
      expect(await readBootId()).toBe(run.worker?.bootId);

      const lock = await readLockMetadata(
        context.storage.path(PAID_JOB_LOCK_SEGMENTS),
      );
      expect(lock).toMatchObject({
        kind: AGENT_RUN_LOCK_KIND,
        ownerId: run.runId,
        pid: process.pid,
      });
      expect(getActiveAgentRunId(context.storage.root)).toBe(run.runId);
      expect(isPaidOperationActive()).toBe(true);
      expect(await loadAgentRun(context.storage, run.runId)).toMatchObject({
        status: "running",
        worker: run.worker,
      });

      const finished = await waitForTerminal(context.storage, run.runId);
      await waitForIdle(context.storage);

      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "completed",
        steps: 3,
        durationMs: 25,
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
        eventCount: 5,
        lastSeq: 5,
      });
      expect(finished.endedAt).not.toBeNull();

      const log = await loadAgentEvents(context.storage, run.runId);
      expect(log.truncated).toBe(false);
      expect(log.events.map((event) => event.kind)).toEqual([
        "agent_start",
        "tool_start",
        "tool_end",
        "turn_end",
        "agent_end",
      ]);
      expect(log.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(log.events.every((event) => event.runId === run.runId)).toBe(true);
      expect(JSON.stringify({ finished, log })).not.toContain(TEST_KEY);

      expect(
        await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
      expect(getActiveAgentRunId(context.storage.root)).toBeNull();
      expect(isPaidOperationActive()).toBe(false);
    },
  );

  it(
    "rejects a second agent start and a competing paid start while a run is active",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("slow");
      await seedKey(context);
      await seedStamp(context);

      const first = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(first.status).toBe("started");
      if (first.status !== "started") return;

      const duplicate = await startAgentRun({
        kind: "task",
        task: "Read the footer.",
        env: context.env,
        storage: context.storage,
      });
      expect(duplicate).toEqual({ status: "run-active", runId: first.run.runId });

      await expect(
        acquireLock(context.storage, PAID_JOB_LOCK_SEGMENTS, {
          kind: PAID_JOB_LOCK_KIND,
          ownerId: randomUUID(),
          maxAttempts: 1,
        }),
      ).rejects.toBeInstanceOf(LockHeldError);

      await expect(
        setOpenRouterKey("another-test-key-88", {
          remember: false,
          env: context.env,
          storage: context.storage,
        }),
      ).rejects.toBeInstanceOf(PaidOperationActiveError);

      const listed = await listAgentRuns(context.storage);
      expect(listed.runs).toHaveLength(1);
      expect(listed.runs[0]?.runId).toBe(first.run.runId);

      await waitForTerminal(context.storage, first.run.runId);
      await waitForIdle(context.storage);
    },
  );

  it(
    "fails before spawning or billing when the app health check does not pass",
    { timeout: 30_000 },
    async () => {
      const stopped = await makeContext("success", {
        origin: await closedOrigin(),
      });
      await seedKey(stopped);
      await seedStamp(stopped);
      const stoppedResult = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: stopped.env,
        storage: stopped.storage,
      });
      expect(stoppedResult.status).toBe("app-unavailable");
      expect(await runFileNames(stopped.storage)).toHaveLength(0);
      expect(
        await readLockMetadata(stopped.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
      expect(existsSync(join(stopped.markersDir, "create.json"))).toBe(false);
      expect(isPaidOperationActive()).toBe(false);

      const wrongMarker = await startHealthServer("some-other-app");
      const wrong = await makeContext("success", { origin: wrongMarker.origin });
      await seedKey(wrong);
      await seedStamp(wrong);
      const wrongResult = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: wrong.env,
        storage: wrong.storage,
      });
      expect(wrongResult.status).toBe("app-unavailable");
      if (wrongResult.status !== "app-unavailable") return;
      expect(wrongResult.message).toContain("health marker");
      expect(await runFileNames(wrong.storage)).toHaveLength(0);
      expect(
        await readLockMetadata(wrong.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
      expect(existsSync(join(wrong.markersDir, "create.json"))).toBe(false);
      expect(isPaidOperationActive()).toBe(false);

      const unavailable = await startHealthServer(HEALTH_MARKER, 503);
      const failing = await makeContext("success", {
        origin: unavailable.origin,
      });
      await seedKey(failing);
      await seedStamp(failing);
      const failingResult = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: failing.env,
        storage: failing.storage,
      });
      expect(failingResult.status).toBe("app-unavailable");
      expect(await runFileNames(failing.storage)).toHaveLength(0);
      expect(existsSync(join(failing.markersDir, "create.json"))).toBe(false);
    },
  );

  it(
    "gates arbitrary tasks on the key and the current verified model stamp",
    { timeout: 45_000 },
    async () => {
      const context = await makeContext("success");

      expect(
        await startAgentRun({
          kind: "task",
          task: "Read the main heading.",
          env: context.env,
          storage: context.storage,
        }),
      ).toEqual({ status: "key-required" });
      expect(
        await startAgentRun({
          kind: "verification",
          env: context.env,
          storage: context.storage,
        }),
      ).toEqual({ status: "key-required" });
      expect(await runFileNames(context.storage)).toHaveLength(0);

      await seedKey(context);
      expect(
        await startAgentRun({
          kind: "task",
          task: "Read the main heading.",
          env: context.env,
          storage: context.storage,
        }),
      ).toEqual({ status: "verification-required", reason: "verification-required" });
      expect(await runFileNames(context.storage)).toHaveLength(0);
      expect(existsSync(join(context.markersDir, "create.json"))).toBe(false);

      const verification = await startAgentRun({
        kind: "verification",
        env: context.env,
        storage: context.storage,
      });
      expect(verification.status).toBe("started");
      if (verification.status !== "started") return;
      expect(verification.run.kind).toBe("verification");
      expect(verification.run.task).toBe(buildVerificationTask(context.origin));
      expect(verification.run.task).toContain(`${context.origin}/shop`);
      expect(verification.run.limits).toEqual(AGENT_VERIFICATION_LIMITS);
      const verificationFinished = await waitForTerminal(
        context.storage,
        verification.run.runId,
      );
      await waitForIdle(context.storage);
      expect(verificationFinished.status).toBe("completed");

      const create = JSON.parse(
        await readFile(join(context.markersDir, "create.json"), "utf8"),
      ) as { model: string };
      expect(create.model).toBe(DEFAULT_BROWSER_MODEL_ID);
      expect(
        await context.storage.readJson(["agent-compatibility.json"]),
      ).toBeUndefined();

      await seedStamp(context, { modelId: "openrouter/other/model" });
      expect(
        await startAgentRun({
          kind: "task",
          task: "Read the main heading.",
          env: context.env,
          storage: context.storage,
        }),
      ).toEqual({ status: "verification-required", reason: "model-mismatch" });

      await seedStamp(context);
      const allowed = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(allowed.status).toBe("started");
      if (allowed.status !== "started") return;
      expect(allowed.run.kind).toBe("task");
      expect(allowed.run.task).toBe("Read the main heading.");
      const allowedFinished = await waitForTerminal(
        context.storage,
        allowed.run.runId,
      );
      await waitForIdle(context.storage);
      expect(allowedFinished.status).toBe("completed");
    },
  );

  it(
    "persists a failed worker run and releases the shared lock",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("launch-failure");
      await seedKey(context);
      await seedStamp(context);

      const started = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;

      const finished = await waitForTerminal(context.storage, started.run.runId);
      await waitForIdle(context.storage);

      expect(finished.status).toBe("failed");
      expect(finished.stopReason).toBeNull();
      expect(finished.error).toContain("Chrome exited before exposing CDP");
      expect(finished.endedAt).not.toBeNull();
      expect(finished.worker?.groupId).toBe(finished.worker?.pid);
      expect(
        existsSync(
          join(context.dataDir, "browser-profiles", started.run.runId),
        ),
      ).toBe(false);
      expect(
        await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
      expect(isPaidOperationActive()).toBe(false);
    },
  );

  it(
    "lists newest runs, reports corrupt files, and leaves state untouched on read",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("success");
      await seedKey(context);

      const started = await startAgentRun({
        kind: "verification",
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      const completed = await waitForTerminal(
        context.storage,
        started.run.runId,
      );
      await waitForIdle(context.storage);

      const limits: AgentRunLimits = { ...AGENT_VERIFICATION_LIMITS };
      const older: AgentRunRecord = {
        version: 2,
        runId: randomUUID(),
        kind: "verification",
        task: "Older verification run.",
        modelId: DEFAULT_BROWSER_MODEL_ID,
        origin: context.origin,
        limits,
        status: "failed",
        stopReason: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        steps: null,
        durationMs: null,
        outputText: null,
        error: "older run failed",
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
      await saveAgentRun(context.storage, older);

      const corruptName = `${randomUUID()}.json`;
      await context.storage.writeFile(
        ["agent-runs", corruptName],
        "{ this is not JSON\n",
      );

      const status = await loadAgentStatus({
        storage: context.storage,
        env: context.env,
      });
      expect(status.activeRunId).toBeNull();
      expect(status.gate).toMatchObject({
        keyAvailable: true,
        verified: false,
        reason: "verification-required",
        modelId: DEFAULT_BROWSER_MODEL_ID,
        origin: context.origin,
      });
      expect(status.runs.map((run) => run.runId)).toEqual([
        completed.runId,
        older.runId,
      ]);
      expect(status.corruptRuns).toBe(1);
      expect(JSON.stringify(status)).not.toContain(TEST_KEY);
      expect(
        await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
      expect(await runFileNames(context.storage)).toContain(corruptName);
      expect(
        (await context.storage.readFile(["agent-runs", corruptName]))?.toString(
          "utf8",
        ),
      ).toContain("not JSON");
    },
  );

  it(
    "degrades the status gate when the installed SDK is unavailable",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("success");
      await seedKey(context);
      const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-sdk-"));
      tempDirs.push(base);
      await mkdir(join(base, "src", "worker"), { recursive: true });
      await writeFile(
        join(base, "src", "worker", "agent-runner.ts"),
        "// stub\n",
      );
      await mkdir(join(base, "node_modules", "tsx"), { recursive: true });
      await writeFile(
        join(base, "node_modules", "tsx", "package.json"),
        JSON.stringify({ name: "tsx", version: "0.0.0" }),
      );

      const status = await loadAgentStatus({
        storage: context.storage,
        env: context.env,
        repoRoot: base,
      });
      expect(status.gate.sdkVersion).toBeNull();
      expect(status.gate.reason).toBe("sdk-unavailable");
      expect(status.gate.verified).toBe(false);

      const result = await startAgentRun({
        kind: "verification",
        env: context.env,
        storage: context.storage,
        repoRoot: base,
      });
      expect(result.status).toBe("worker-unavailable");
      expect(await runFileNames(context.storage)).toHaveLength(0);
      expect(existsSync(join(context.markersDir, "create.json"))).toBe(false);
      expect(isPaidOperationActive()).toBe(false);
      expect(
        await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
    },
  );

  it("refuses to resolve a missing worker or runtime dependency", async () => {
    const command = buildAgentWorkerCommand(process.cwd());
    expect(isAbsolute(command.command)).toBe(true);
    expect(command.cwd).toBe(resolve(process.cwd()));
    expect(command.args).toEqual([
      "--import",
      "tsx",
      resolveAgentWorkerPath(process.cwd()),
    ]);
    expect(command.args.join(" ")).not.toContain(TEST_KEY);

    const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-root-"));
    tempDirs.push(base);
    expect(() => resolveAgentWorkerPath(base)).toThrow(
      AgentWorkerUnavailableError,
    );

    await mkdir(join(base, "src", "worker"), { recursive: true });
    await writeFile(join(base, "src", "worker", "agent-runner.ts"), "// stub\n");
    expect(() => buildAgentWorkerCommand(base)).toThrow(/tsx runtime dependency/);
  });

  it(
    "refuses a start while an image-style paid operation holds the lock",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("success");
      await seedKey(context);
      await seedStamp(context);
      const imageJobId = randomUUID();
      const lock = await acquireLock(context.storage, PAID_JOB_LOCK_SEGMENTS, {
        kind: PAID_JOB_LOCK_KIND,
        ownerId: imageJobId,
        maxAttempts: 1,
      });
      beginPaidOperation(imageJobId, PAID_JOB_LOCK_KIND);
      try {
        expect(
          await startAgentRun({
            kind: "task",
            task: "Read the main heading.",
            env: context.env,
            storage: context.storage,
          }),
        ).toEqual({ status: "paid-operation-active" });
        expect(await runFileNames(context.storage)).toHaveLength(0);
        expect(existsSync(join(context.markersDir, "create.json"))).toBe(false);
      } finally {
        endPaidOperation(imageJobId);
        await lock.release();
      }
    },
  );

  it(
    "caps persisted events for a flood of worker events",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("flood");
      await seedKey(context);
      await seedStamp(context);
      const started = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      const finished = await waitForTerminal(context.storage, started.run.runId);
      await waitForIdle(context.storage);
      expect(finished.status).toBe("completed");
      expect(finished.eventCount).toBe(AGENT_WORKER_MAX_EVENTS);
      expect(finished.lastSeq).toBe(AGENT_WORKER_MAX_EVENTS);
      const log = await loadAgentEvents(context.storage, started.run.runId);
      expect(log.events).toHaveLength(AGENT_WORKER_MAX_EVENTS);
      expect(log.events[0]?.seq).toBe(1);
      expect(log.events.at(-1)?.seq).toBe(AGENT_WORKER_MAX_EVENTS);
    },
  );

  it("does not delete key temp leftovers on a read-only status call", async () => {
    const context = await makeContext("success");
    const tempName = ".openrouter-key.deadbeef.tmp";
    await context.storage.writeFile(
      ["secrets", tempName],
      "sk-or-v1-leftover-secret\n",
    );
    const status = await loadAgentStatus({
      storage: context.storage,
      env: context.env,
    });
    expect(status.gate.keyAvailable).toBe(false);
    expect(await context.storage.listFiles(["secrets"])).toContain(tempName);
  });

  it(
    "cancels a running mocked run cooperatively and records the cancel",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("hang");
      await seedKey(context);
      await seedStamp(context);

      const started = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      const runId = started.run.runId;
      await waitForMarkerFile(context.markersDir, "run.json");

      expect(cancelAgentRun({
        runId,
        env: context.env,
        storage: context.storage,
      })).toEqual({ status: "cancelling", runId });

      const cancelling = await waitForRunStatus(
        context.storage,
        runId,
        "cancelling",
      );
      expect(cancelling.cancelReason).toBe("user");
      expect(cancelling.cancelRequestedAt).not.toBeNull();
      expect(cancelling.watchdogExpiredAt).toBeNull();

      const finished = await waitForTerminal(context.storage, runId);
      await waitForIdle(context.storage);

      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "cancelled",
        cancelReason: "user",
        watchdogExpiredAt: null,
      });
      expect(finished.error).toContain("cancelled");
      const cancel = await readMarker<Record<string, unknown>>(
        context.markersDir,
        "cancel.json",
      );
      expect(cancel.cancelCount).toBeGreaterThanOrEqual(1);
      const close = await readMarker<Record<string, unknown>>(
        context.markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
      expect(
        existsSync(join(context.dataDir, "browser-profiles", runId)),
      ).toBe(false);
      expect(
        await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
      expect(getActiveAgentRunId(context.storage.root)).toBeNull();
      expect(JSON.stringify(finished)).not.toContain(TEST_KEY);
    },
  );

  it(
    "reports no active run or a mismatched run for a cancel request",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("hang");
      await seedKey(context);
      await seedStamp(context);

      expect(
        cancelAgentRun({ env: context.env, storage: context.storage }),
      ).toEqual({ status: "no-active-run" });

      const started = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      await waitForMarkerFile(context.markersDir, "run.json");

      expect(
        cancelAgentRun({
          runId: randomUUID(),
          env: context.env,
          storage: context.storage,
        }),
      ).toEqual({ status: "run-mismatch", activeRunId: started.run.runId });

      // The mismatched request must not have cancelled the active run.
      expect((await loadAgentRun(context.storage, started.run.runId))?.status).toBe(
        "running",
      );
      await cancelAgentRun({
        runId: started.run.runId,
        env: context.env,
        storage: context.storage,
      });
      const finished = await waitForTerminal(
        context.storage,
        started.run.runId,
      );
      await waitForIdle(context.storage);
      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "cancelled",
      });
    },
  );

  it(
    "records an SDK-reported timeout as a distinct terminal status",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("timeout");
      await seedKey(context);
      await seedStamp(context);

      const started = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      const finished = await waitForTerminal(
        context.storage,
        started.run.runId,
      );
      await waitForIdle(context.storage);

      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "timeout",
        cancelRequestedAt: null,
        watchdogExpiredAt: null,
      });
      expect(finished.error).toContain("wall-clock timeout");
    },
  );

  it(
    "marks a hung mock for forced cleanup after the watchdog grace (fake timers)",
    { timeout: 30_000 },
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const context = await makeContext("hang-forever");
        await seedKey(context);
        await seedStamp(context);

        const started = await startAgentRun({
          kind: "task",
          task: "Read the main heading.",
          limits: { timeoutMs: 10_000 },
          env: context.env,
          storage: context.storage,
        });
        expect(started.status).toBe("started");
        if (started.status !== "started") return;
        const runId = started.run.runId;
        await waitForMarkerFile(context.markersDir, "run.json");

        // Watchdog: SDK timeout plus margin -> cooperative cancel.
        await vi.advanceTimersByTimeAsync(10_000 + AGENT_WATCHDOG_MARGIN_MS);
        await waitForMarkerFile(context.markersDir, "cancel.json");
        const cancelling = await waitForRecord(
          context.storage,
          runId,
          (record) => record.status === "cancelling",
        );
        expect(cancelling.cancelReason).toBe("watchdog");
        expect(cancelling.cancelRequestedAt).not.toBeNull();

        // Grace period expires with an SDK that ignores the abort.
        await vi.advanceTimersByTimeAsync(AGENT_CANCEL_GRACE_MS);
        const hung = await waitForRecord(
          context.storage,
          runId,
          (record) => record.status === "hung",
        );
        expect(hung.watchdogExpiredAt).not.toBeNull();
        expect(hung.endedAt).toBeNull();
        expect(hung.error).toContain("forced cleanup");

        // The hung run keeps the paid lock and the active registration until
        // the process is proven gone; Phase 26 owns the forced kill.
        expect(
          await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
        ).toBeDefined();
        expect(getActiveAgentRunId(context.storage.root)).toBe(runId);
        expect(isPaidOperationActive()).toBe(true);
        expect(
          existsSync(join(context.dataDir, "browser-profiles", runId)),
        ).toBe(true);
        expect(
          cancelAgentRun({
            runId,
            env: context.env,
            storage: context.storage,
          }),
        ).toEqual({ status: "run-hung", runId });

        // Forced cleanup stand-in: kill the process, then the supervisor may
        // release the lock because ownership is now proven gone.
        const pid = started.run.worker?.pid ?? 0;
        expect(pid).toBeGreaterThan(0);
        process.kill(pid, "SIGKILL");
        const deadline = Date.now() + 10_000;
        while (
          Date.now() < deadline &&
          (await readLockMetadata(
            context.storage.path(PAID_JOB_LOCK_SEGMENTS),
          ).catch(() => null)) !== undefined
        ) {
          await new Promise<void>((resolvePromise) =>
            setImmediate(resolvePromise),
          );
        }
        expect(
          await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
        ).toBeUndefined();
        expect(getActiveAgentRunId(context.storage.root)).toBeNull();
        expect(isPaidOperationActive()).toBe(false);
        const finalized = await loadAgentRun(context.storage, runId);
        expect(finalized?.status).toBe("failed");
        expect(finalized?.watchdogExpiredAt).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "settles the watchdog cancel cooperatively when the SDK honours the abort",
    { timeout: 30_000 },
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let context: TestContext | undefined;
      let runId = "";
      try {
        context = await makeContext("hang");
        await seedKey(context);
        await seedStamp(context);
        const started = await startAgentRun({
          kind: "task",
          task: "Read the main heading.",
          limits: { timeoutMs: 10_000 },
          env: context.env,
          storage: context.storage,
        });
        expect(started.status).toBe("started");
        if (started.status !== "started") return;
        runId = started.run.runId;
        await waitForMarkerFile(context.markersDir, "run.json");

        await vi.advanceTimersByTimeAsync(10_000 + AGENT_WATCHDOG_MARGIN_MS);
        const cancelling = await waitForRecord(
          context.storage,
          runId,
          (record) => record.status === "cancelling",
        );
        expect(cancelling.cancelReason).toBe("watchdog");

        // The fake SDK settles 150 ms (real time) after the abort.
        const finished = await waitForRecord(
          context.storage,
          runId,
          (record) => isTerminalAgentRunStatus(record.status),
          20_000,
        );
        expect(finished).toMatchObject({
          status: "completed",
          stopReason: "cancelled",
          cancelReason: "watchdog",
          watchdogExpiredAt: null,
        });
      } finally {
        vi.useRealTimers();
      }
      if (!context) return;
      await waitForMarkerFile(context.markersDir, "close.json");
      const close = await readMarker<Record<string, unknown>>(
        context.markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
      expect(
        existsSync(join(context.dataDir, "browser-profiles", runId)),
      ).toBe(false);
      await waitForIdle(context.storage);
      const finalized = await loadAgentRun(context.storage, runId);
      expect(finalized).toMatchObject({
        status: "completed",
        stopReason: "cancelled",
        cancelReason: "watchdog",
        watchdogExpiredAt: null,
      });
    },
  );

  it("removes the key and keeps the status gate honest", async () => {
    const context = await makeContext("success");
    await seedKey(context);
    await seedStamp(context);
    expect(
      (await loadAgentStatus({ storage: context.storage, env: context.env }))
        .gate.verified,
    ).toBe(true);

    await deleteOpenRouterKey({
      env: context.env,
      storage: context.storage,
    });
    const status = await loadAgentStatus({
      storage: context.storage,
      env: context.env,
    });
    expect(status.gate.keyAvailable).toBe(false);
    expect(status.gate.verified).toBe(false);
    expect(status.gate.reason).toBe("key-required");
    expect(
      await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      }),
    ).toEqual({ status: "key-required" });
  });
});
