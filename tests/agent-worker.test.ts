import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_DEFAULT_LIMITS,
  AGENT_WORKER_MAX_EVENTS,
  agentWorkerMessageSchema,
} from "../src/lib/agent-ipc";
import {
  blockedOriginInCode,
  cleanupVerifiedStatus,
} from "../src/worker/agent-runner";

const TEST_KEY = "worker-test-secret-key-42";
const RUN_ID = "8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d";
const fakeSdkUrl = new URL(
  "./fixtures/fake-agent-worker-sdk.mjs",
  import.meta.url,
).href;

const tempDirs: string[] = [];
const workers: WorkerHarness[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => stopWorker(worker)));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function stopWorker(worker: WorkerHarness): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = worker.waitForExit(3_000).catch(() => undefined);
  worker.child.kill("SIGKILL");
  await exited;
}

async function makeBase(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-worker-"));
  tempDirs.push(base);
  return base;
}

function workerEnv(
  dataDir: string,
  markersDir: string,
  mode: string,
): Record<string, string> {
  return {
    DATA_DIR: dataDir,
    LAB_TEST_MODE: "1",
    OPENROUTER_API_KEY: TEST_KEY,
    AGENT_WORKER_TEST_SDK: fakeSdkUrl,
    AGENT_WORKER_FAKE_MODE: mode,
    AGENT_WORKER_TEST_MARKERS: markersDir,
  };
}

function startMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "start",
    runId: RUN_ID,
    model: "openrouter/openai/gpt-5.6-luna",
    task: "Open the storefront and read the main heading.",
    startUrl: "http://127.0.0.1:3000",
    limits: { ...AGENT_RUN_DEFAULT_LIMITS },
    headless: false,
    ...overrides,
  };
}

interface WorkerExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface WorkerHarness {
  readonly child: ChildProcess;
  readonly messages: Array<Record<string, unknown>>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  send(message: object): void;
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForExit(timeoutMs?: number): Promise<WorkerExit>;
}

function startWorker(env: Record<string, string>, useIpc = true): WorkerHarness {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/worker/agent-runner.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env },
      stdio: useIpc
        ? ["ignore", "pipe", "pipe", "ipc"]
        : ["ignore", "pipe", "pipe"],
    },
  );

  const messages: Array<Record<string, unknown>> = [];
  let stdout = "";
  let stderr = "";
  let exit: WorkerExit | undefined;
  const waiters = new Set<{
    type: string;
    resolve: (message: Record<string, unknown>) => void;
  }>();

  const exitPromise = new Promise<WorkerExit>((resolve) => {
    child.once("exit", (code) => {
      exit = { code, stdout, stderr };
      resolve(exit);
    });
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as Record<string, unknown>;
    messages.push(message);
    for (const waiter of waiters) {
      if (waiter.type === message.type) {
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });

  const timeout = <T>(promise: Promise<T>, timeoutMs: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for ${what}. stdout=${stdout} stderr=${stderr}`,
            ),
          ),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  const harness: WorkerHarness = {
    child,
    messages,
    stdout: () => stdout,
    stderr: () => stderr,
    send(message: object) {
      child.send(message);
    },
    waitFor(type: string, timeoutMs = 15_000) {
      const existing = messages.find((message) => message.type === type);
      if (existing) return Promise.resolve(existing);
      return timeout(
        new Promise<Record<string, unknown>>((resolve) => {
          waiters.add({ type, resolve });
        }),
        timeoutMs,
        `a ${type} message`,
      );
    },
    waitForExit(timeoutMs = 15_000) {
      return exit ? Promise.resolve(exit) : timeout(exitPromise, timeoutMs, "worker exit");
    },
  };
  workers.push(harness);
  return harness;
}

async function readMarker<T>(
  markersDir: string,
  name: string,
): Promise<T> {
  return JSON.parse(await readFile(join(markersDir, name), "utf8")) as T;
}

async function waitForMarkerFile(
  markersDir: string,
  name: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(join(markersDir, name))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the worker marker ${name}.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function profileDirFor(dataDir: string, runId = RUN_ID): string {
  return join(dataDir, "browser-profiles", runId);
}

describe("isolated agent worker", () => {
  it(
    "runs one mocked task, reports bounded events, and cleans up its profile",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "success"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      const result = await worker.waitFor("result");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(0);
      expect(result).toMatchObject({
        type: "result",
        runId: RUN_ID,
        status: "completed",
        outputText: '{"heading":"Shop"}',
        error: null,
        steps: 3,
        durationMs: 25,
        imageInputObserved: false,
      });
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedCostUsd: 0.01,
      });

      const types = worker.messages.map((message) => message.type);
      expect(types[0]).toBe("ready");
      expect(types[1]).toBe("started");
      expect(types.at(-1)).toBe("result");
      for (const message of worker.messages) {
        expect(agentWorkerMessageSchema.safeParse(message).success).toBe(true);
      }
      const events = worker.messages.filter((message) => message.type === "event");
      expect(events.map((event) => event.kind)).toEqual([
        "agent_start",
        "tool_start",
        "tool_end",
        "turn_end",
        "agent_end",
      ]);
      const sequences = events.map((event) => event.seq);
      expect(sequences).toEqual([1, 2, 3, 4, 5]);

      const create = await readMarker<Record<string, unknown>>(
        markersDir,
        "create.json",
      );
      expect(create).toMatchObject({
        model: "openrouter/openai/gpt-5.6-luna",
        telemetry: false,
        highlightActions: true,
        researchTools: false,
        log: false,
        allowedDomains: ["127.0.0.1"],
        prohibitedDomains: [],
        redactCount: 1,
        redactedSecretMatches: true,
        profileDir: profileDirFor(dataDir),
        headless: false,
        maxOutputChars: 20_000,
      });
      expect(create.instructions).toContain("Never run shell commands");

      const run = await readMarker<Record<string, unknown>>(markersDir, "run.json");
      expect(run).toMatchObject({
        task: "Open the storefront and read the main heading.",
        maxSteps: AGENT_RUN_DEFAULT_LIMITS.maxSteps,
        timeoutMs: AGENT_RUN_DEFAULT_LIMITS.timeoutMs,
        maxCostUsd: AGENT_RUN_DEFAULT_LIMITS.maxCostUsd,
        hasSignal: true,
      });

      const close = await readMarker<Record<string, unknown>>(
        markersDir,
        "close.json",
      );
      expect(close).toMatchObject({
        count: 1,
        profileDir: profileDirFor(dataDir),
        profileExistsAtClose: true,
      });

      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
      expect(worker.stdout()).not.toContain(TEST_KEY);
      expect(worker.stderr()).not.toContain(TEST_KEY);
      expect(JSON.stringify(worker.messages)).not.toContain(TEST_KEY);
    },
  );

  it(
    "closes the browser and redacts secrets when the mocked run fails",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "failure"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      const result = await worker.waitFor("result");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(0);
      expect(result).toMatchObject({
        status: "error",
        steps: 2,
        durationMs: 5,
        imageInputObserved: false,
      });
      expect(String(result.error)).toContain("[redacted]");
      expect(String(result.error)).not.toContain(TEST_KEY);
      expect(JSON.stringify(worker.messages)).not.toContain(TEST_KEY);
      expect(worker.stdout()).not.toContain(TEST_KEY);
      expect(worker.stderr()).not.toContain(TEST_KEY);

      const close = await readMarker<Record<string, unknown>>(
        markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "reports an SDK throw as a redacted error result and still cleans up",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "throw"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      const result = await worker.waitFor("result");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(0);
      expect(result).toMatchObject({
        status: "error",
        error: "The SDK crashed with [redacted]",
        steps: null,
        durationMs: null,
      });
      expect(JSON.stringify(worker.messages)).not.toContain(TEST_KEY);
      expect(worker.stdout()).not.toContain(TEST_KEY);
      expect(worker.stderr()).not.toContain(TEST_KEY);

      const close = await readMarker<Record<string, unknown>>(
        markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "does not count an SDK error terminal frame as a page action",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      for (const mode of ["error-recording", "incomplete-recording"]) {
        const worker = startWorker(workerEnv(dataDir, markersDir, mode));
        await worker.waitFor("ready");
        worker.send(startMessage());
        const result = await worker.waitFor("result");
        await worker.waitForExit();

        expect(result.status).toBe(
          mode === "error-recording" ? "error" : "incomplete",
        );
        expect(result.pageActionObserved).toBe(false);
        expect(result.navigationObserved).toBe(false);
      }
    },
  );

  it(
    "does not claim vision when the run ends before another model request",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(
        workerEnv(dataDir, markersDir, "vision-no-followup"),
      );

      await worker.waitFor("ready");
      worker.send(startMessage());
      const result = await worker.waitFor("result");
      await worker.waitForExit();

      expect(result.imageInputObserved).toBe(false);
      const toolEnd = worker.messages.find(
        (message) => message.type === "event" && message.kind === "tool_end",
      );
      expect(toolEnd?.imageContent).toBe(true);
    },
  );

  it(
    "terminates owned browser processes when the parent disconnects during a hung close",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const env = workerEnv(dataDir, markersDir, "close-hang");
      env.AGENT_WORKER_ORPHAN_DEADLINE_MS = "200";
      const worker = startWorker(env);

      await worker.waitFor("ready");
      worker.send(startMessage());
      await worker.waitFor("result");
      await waitForMarkerFile(markersDir, "close-grandchild.json");
      const grandchild = await readMarker<{ pid: number }>(
        markersDir,
        "close-grandchild.json",
      );

      worker.child.disconnect();
      const exit = await worker.waitForExit(15_000);
      expect(exit.code).toBe(1);
      expect(() => process.kill(grandchild.pid, 0)).toThrow();
    },
  );

  it(
    "removes run directories only after verifying cleanup when close fails",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const env = workerEnv(dataDir, markersDir, "close-error");
      const worker = startWorker(env);

      await worker.waitFor("ready");
      worker.send(startMessage());
      const result = await worker.waitFor("result");
      expect(result.type).toBe("result");
      const exit = await worker.waitForExit(15_000);
      expect(exit.code).toBe(0);

      const start = await readMarker<{ profileDir: string; workspace: string }>(
        markersDir,
        "create.json",
      );
      await expect(stat(start.profileDir)).rejects.toThrow();
      await expect(stat(start.workspace)).rejects.toThrow();
    },
  );

  it(
    "cancels a hanging mocked run and still closes the browser",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "hang"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      await worker.waitFor("started");
      worker.send({ type: "cancel", reason: "test cancellation" });
      const result = await worker.waitFor("result");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(0);
      expect(result).toMatchObject({
        status: "cancelled",
        outputText: "cancelled by the supervisor",
      });
      const cancel = await readMarker<Record<string, unknown>>(
        markersDir,
        "cancel.json",
      );
      expect(cancel.cancelCount).toBeGreaterThanOrEqual(1);
      const close = await readMarker<Record<string, unknown>>(
        markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "treats an IPC disconnect as a cooperative cancel and still closes the browser",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "hang"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      await worker.waitFor("started");
      await waitForMarkerFile(markersDir, "run.json");

      worker.child.disconnect();
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      expect(exit.stderr).toContain("parent process disconnected");
      expect(exit.stderr).toContain("cancelling the run");
      expect(worker.messages.some((message) => message.type === "result")).toBe(
        false,
      );
      const close = await readMarker<Record<string, unknown>>(
        markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "exits without a run when the parent disconnects before the start",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "success"));

      await worker.waitFor("ready");
      worker.child.disconnect();
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      expect(exit.stderr).toContain("disconnected before the run started");
      expect(await pathExists(join(markersDir, "create.json"))).toBe(false);
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "sends liveness heartbeats while a run is active",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "hang"));

      await worker.waitFor("ready");
      worker.send(startMessage({ heartbeatMs: 250 }));
      await worker.waitFor("started");
      const first = await worker.waitFor("heartbeat");
      expect(first.runId).toBe(RUN_ID);
      expect(typeof first.at).toBe("string");

      await new Promise((resolve) => setTimeout(resolve, 600));
      const heartbeats = worker.messages.filter(
        (message) => message.type === "heartbeat",
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      for (const heartbeat of heartbeats) {
        expect(agentWorkerMessageSchema.safeParse(heartbeat).success).toBe(true);
      }

      worker.send({ type: "cancel", reason: "test done" });
      const result = await worker.waitFor("result");
      expect(result.status).toBe("cancelled");
      const beforeResult = worker.messages.filter(
        (message) => message.type === "heartbeat",
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(
        worker.messages.filter((message) => message.type === "heartbeat"),
      ).toHaveLength(beforeResult);
      const exit = await worker.waitForExit();
      expect(exit.code).toBe(0);
      const close = await readMarker<Record<string, unknown>>(
        markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
    },
  );

  it(
    "reports a launch failure as a terminal error and removes the profile",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "launch-failure"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      const error = await worker.waitFor("error");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      expect(String(error.message)).toContain("Chrome exited before exposing CDP");
      expect(error.runId).toBe(RUN_ID);
      expect(worker.messages.some((message) => message.type === "started")).toBe(
        false,
      );
      expect(worker.messages.some((message) => message.type === "result")).toBe(
        false,
      );
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "marks observed tool image content without claiming vision support",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "vision"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      const result = await worker.waitFor("result");
      await worker.waitForExit();

      expect(result.imageInputObserved).toBe(true);
      const toolEnd = worker.messages.find(
        (message) => message.type === "event" && message.kind === "tool_end",
      );
      expect(toolEnd?.imageContent).toBe(true);
    },
  );

  it(
    "bounds the number of event messages while still delivering the result",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "flood"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      const result = await worker.waitFor("result");
      const exit = await worker.waitForExit();

      const events = worker.messages.filter((message) => message.type === "event");
      expect(events).toHaveLength(AGENT_WORKER_MAX_EVENTS);
      expect(events.at(-1)?.seq).toBe(AGENT_WORKER_MAX_EVENTS);
      expect(result.status).toBe("completed");
      expect(exit.code).toBe(0);
    },
  );

  it(
    "rejects invalid parent messages as a protocol violation",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "success"));

      await worker.waitFor("ready");
      worker.send(startMessage({ runId: "not-a-uuid" }));
      const error = await worker.waitFor("error");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      expect(String(error.message)).toContain("protocol violation");
      expect(await pathExists(join(markersDir, "run.json"))).toBe(false);
    },
  );

  it(
    "refuses a second start while a run is active and cancels it",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "hang"));

      await worker.waitFor("ready");
      worker.send(startMessage());
      await worker.waitFor("started");
      worker.send(startMessage());
      const error = await worker.waitFor("error");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      expect(String(error.message)).toContain("protocol violation");
      const close = await readMarker<Record<string, unknown>>(
        markersDir,
        "close.json",
      );
      expect(close.count).toBe(1);
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "refuses a non-loopback start URL without preparing a profile",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(workerEnv(dataDir, markersDir, "success"));

      await worker.waitFor("ready");
      worker.send(startMessage({ startUrl: "http://192.168.1.10:3000" }));
      const error = await worker.waitFor("error");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      expect(String(error.message)).toContain("loopback host");
      expect(await pathExists(join(markersDir, "create.json"))).toBe(false);
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "refuses a production SDK override outside test mode",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker({
        ...workerEnv(dataDir, markersDir, "success"),
        LAB_TEST_MODE: "0",
      });

      await worker.waitFor("ready");
      worker.send(startMessage());
      const error = await worker.waitFor("error");
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      expect(String(error.message)).toContain("AGENT_WORKER_TEST_SDK");
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it("refuses to start without a usable key", { timeout: 30_000 }, async () => {
    const base = await makeBase();
    const dataDir = join(base, "data");
    const markersDir = join(base, "markers");
    const worker = startWorker({
      ...workerEnv(dataDir, markersDir, "success"),
      OPENROUTER_API_KEY: "",
    });

    const exit = await worker.waitForExit();

    expect(exit.code).toBe(1);
    expect(exit.stderr).toContain("OpenRouter API key");
    expect(worker.messages).toHaveLength(0);
  });

  it("requires an IPC channel", { timeout: 30_000 }, async () => {
    const base = await makeBase();
    const dataDir = join(base, "data");
    const markersDir = join(base, "markers");
    const worker = startWorker(workerEnv(dataDir, markersDir, "success"), false);

    const exit = await worker.waitForExit();

    expect(exit.code).toBe(1);
    expect(exit.stderr).toContain("IPC channel");
  });

  it(
    "fails with exit code 1 when the terminal result cannot be delivered",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const worker = startWorker(
        workerEnv(dataDir, markersDir, "wait-for-disconnect"),
      );

      await worker.waitFor("ready");
      worker.send(startMessage());
      await worker.waitFor("started");
      worker.child.disconnect();
      const exit = await worker.waitForExit();

      expect(exit.code).toBe(1);
      // Since Phase 25 the worker recognizes the lost parent and says so.
      expect(exit.stderr).toContain(
        "parent process disconnected before the worker could deliver its result",
      );
      expect(worker.messages.some((message) => message.type === "result")).toBe(
        false,
      );
      expect(await pathExists(profileDirFor(dataDir))).toBe(false);
    },
  );

  it(
    "uses one dedicated profile directory per run id",
    { timeout: 30_000 },
    async () => {
      const base = await makeBase();
      const dataDir = join(base, "data");
      const markersDir = join(base, "markers");
      const otherRunId = randomUUID();
      const worker = startWorker(workerEnv(dataDir, markersDir, "success"));

      await worker.waitFor("ready");
      worker.send(startMessage({ runId: otherRunId }));
      await worker.waitFor("result");
      await worker.waitForExit();

      const create = await readMarker<{ profileDir: string }>(
        markersDir,
        "create.json",
      );
      expect(create.profileDir).toBe(join(dataDir, "browser-profiles", otherRunId));
      expect(await pathExists(create.profileDir)).toBe(false);
    },
  );
});

describe("worker origin guard", () => {
  const origin = "http://127.0.0.1:3000";

  it("allows only the configured origin and port", () => {
    expect(blockedOriginInCode(`await page.goto("${origin}/shop")`, origin)).toBeNull();
    expect(
      blockedOriginInCode(`await page.goto("http://127.0.0.1:3001/")`, origin),
    ).toContain("127.0.0.1:3001");
    expect(
      blockedOriginInCode(`await page.goto("https://127.0.0.1:3000/")`, origin),
    ).not.toBeNull();
    expect(
      blockedOriginInCode(`await page.goto("//127.0.0.1:3001/x")`, origin),
    ).not.toBeNull();
    expect(blockedOriginInCode(`fetch("http://example.com")`, origin)).not.toBeNull();
  });
});

describe("worker cleanup gate", () => {
  it("allows directory removal only for verified owned-process cleanup", () => {
    expect(cleanupVerifiedStatus("terminated")).toBe(true);
    expect(cleanupVerifiedStatus("already-gone")).toBe(true);
    expect(cleanupVerifiedStatus("escaped")).toBe(false);
  });
});
