import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildVerificationSettler,
  evaluateVerificationRun,
  parseVerificationHeading,
  verifyAgentModel,
} from "../src/server/agent-verification";
import {
  loadAgentCompatibility,
  saveAgentCompatibility,
} from "../src/server/agent-compatibility";
import {
  AGENT_RUN_VERSION,
  isTerminalAgentRunStatus,
  listAgentRuns,
  loadAgentRun,
  saveAgentRun,
  type AgentRunRecord,
} from "../src/server/agent-runs";
import {
  AGENT_VERIFICATION_LIMITS,
  evaluateAgentGate,
  getActiveAgentRunId,
  readInstalledSdkVersion,
  resetAgentSupervisorForTests,
  startAgentRun,
} from "../src/server/agent-manager";
import {
  loadOpenRouterKey,
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "../src/server/credentials";
import {
  DEFAULT_BROWSER_MODEL_ID,
  loadModelSettings,
  saveModelSettings,
  updateBrowserSettings,
} from "../src/server/model-settings";
import { resetPaidOperationsForTests } from "../src/server/paid-operation";
import { readLockMetadata } from "../src/server/lock";
import { PAID_JOB_LOCK_SEGMENTS } from "../src/server/paid-lock";
import { createStorage, type Storage } from "../src/server/storage";

const TEST_KEY = "verification-test-secret-key-42";
const OTHER_KEY = "verification-test-other-key-43";
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

async function startHealthServer(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, app: "ai-browser-agent-lab" }));
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
  return `http://127.0.0.1:${address.port}`;
}

async function makeContext(mode: string): Promise<TestContext> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-verification-"));
  tempDirs.push(base);
  const origin = await startHealthServer();
  const env: Record<string, string> = {
    DATA_DIR: join(base, "data"),
    LAB_TEST_MODE: "1",
    APP_ORIGIN: origin,
    AGENT_WORKER_TEST_SDK: fakeSdkUrl,
    AGENT_WORKER_FAKE_MODE: mode,
    AGENT_WORKER_TEST_MARKERS: join(base, "markers"),
  };
  return {
    dataDir: env.DATA_DIR ?? "",
    markersDir: env.AGENT_WORKER_TEST_MARKERS ?? "",
    origin,
    env,
    storage: createStorage(env),
  };
}

async function seedKey(
  context: TestContext,
  key: string = TEST_KEY,
): Promise<void> {
  await setOpenRouterKey(key, {
    remember: false,
    env: context.env,
    storage: context.storage,
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
  throw new Error("Timed out waiting for the verification run to finish.");
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
  throw new Error("Timed out waiting for the verification run to release its lock.");
}

async function waitForMarkerFile(
  markersDir: string,
  name: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(join(markersDir, name))) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for the worker marker ${name}.`);
}

function makeRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: AGENT_RUN_VERSION,
    runId: "11111111-1111-4111-8111-111111111111",
    kind: "verification",
    presetId: null,
    task: "Read the Shop heading.",
    modelId: DEFAULT_BROWSER_MODEL_ID,
    origin: "http://127.0.0.1:3000",
    limits: { ...AGENT_VERIFICATION_LIMITS },
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
      estimatedCostUsd: 0.001,
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

describe("verification answer parsing", () => {
  it("accepts only the strict neutral heading shape", () => {
    expect(parseVerificationHeading(null)).toBeNull();
    expect(parseVerificationHeading("")).toBeNull();
    expect(parseVerificationHeading("   ")).toBeNull();
    expect(parseVerificationHeading("Shop")).toBeNull();
    expect(parseVerificationHeading('"Shop"')).toBeNull();
    expect(parseVerificationHeading("[]")).toBeNull();
    expect(parseVerificationHeading('{"heading":5}')).toBeNull();
    expect(parseVerificationHeading('{"heading":"   "}')).toBeNull();
    expect(parseVerificationHeading(`{"heading":"${"x".repeat(201)}"}`)).toBeNull();
    expect(parseVerificationHeading('```json\n{"heading":"Shop"}\n```')).toBeNull();
    expect(parseVerificationHeading('{"heading":"Shop"}')).toBe("Shop");
    expect(parseVerificationHeading('{"heading":" Shop "}')).toBe("Shop");
  });
});

describe("verification evaluation", () => {
  it("passes only a completed run with the exact Shop heading", () => {
    expect(evaluateVerificationRun(makeRecord())).toMatchObject({
      status: "passed",
    });
    expect(
      evaluateVerificationRun(makeRecord({ kind: "task" })).status,
    ).toBe("failed");
    expect(
      evaluateVerificationRun(makeRecord({ status: "running", endedAt: null }))
        .status,
    ).toBe("failed");
    expect(
      evaluateVerificationRun(makeRecord({ stopReason: "cancelled" })).status,
    ).toBe("failed");
    expect(
      evaluateVerificationRun(makeRecord({ outputText: "The heading is Shop." }))
        .status,
    ).toBe("failed");
    expect(
      evaluateVerificationRun(makeRecord({ outputText: '{"heading":"Storefront"}' }))
        .status,
    ).toBe("failed");
    expect(
      evaluateVerificationRun(makeRecord({ status: "failed", error: "boom" })),
    ).toMatchObject({ status: "failed", reason: "boom" });
  });
});

describe("browser-based model verification", () => {
  it(
    "stamps the current tuple after a mocked Shop heading and unlocks live tasks",
    { timeout: 45_000 },
    async () => {
      const context = await makeContext("success");
      await seedKey(context);

      const before = await evaluateAgentGate({
        storage: context.storage,
        env: context.env,
      });
      expect(before).toMatchObject({
        keyAvailable: true,
        verified: false,
        reason: "verification-required",
        modelId: DEFAULT_BROWSER_MODEL_ID,
        origin: context.origin,
      });

      const started = await verifyAgentModel({
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      expect(started.run).toMatchObject({
        kind: "verification",
        status: "running",
        modelId: DEFAULT_BROWSER_MODEL_ID,
        origin: context.origin,
        limits: AGENT_VERIFICATION_LIMITS,
        evaluation: { status: "not_evaluated", reason: null },
        vision: "unverified",
      });
      expect(started.run.task).toContain(`${context.origin}/shop`);

      await waitForTerminal(context.storage, started.run.runId);
      await waitForIdle(context.storage);
      // The evaluation and stamp are persisted inside the supervisor's settle
      // hook before the lock is released, so re-read the settled record.
      const finished = await loadAgentRun(context.storage, started.run.runId);
      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "completed",
        outputText: '{"heading":"Shop"}',
        evaluation: {
          status: "passed",
          reason: "The model read the Shop heading from the running app.",
        },
        vision: "unverified",
      });

      const stamp = await loadAgentCompatibility(context.storage);
      expect(stamp).toMatchObject({
        version: 1,
        modelId: DEFAULT_BROWSER_MODEL_ID,
        sdkVersion: await readInstalledSdkVersion(),
        origin: context.origin,
        vision: "unverified",
      });
      expect(Number.isNaN(Date.parse(stamp?.verifiedAt ?? ""))).toBe(false);

      const after = await evaluateAgentGate({
        storage: context.storage,
        env: context.env,
      });
      expect(after).toMatchObject({
        verified: true,
        reason: "verified",
        vision: "unverified",
      });
      expect(after.verifiedAt).toBe(stamp?.verifiedAt);

      const task = await startAgentRun({
        kind: "task",
        task: "Read the main heading.",
        env: context.env,
        storage: context.storage,
      });
      expect(task.status).toBe("started");
      if (task.status === "started") {
        expect(task.run.kind).toBe("task");
        await waitForTerminal(context.storage, task.run.runId);
        await waitForIdle(context.storage);
      }
      expect(JSON.stringify({ started, finished, stamp })).not.toContain(TEST_KEY);
    },
  );

  it(
    "does not stamp a wrong or unparsable heading answer",
    { timeout: 45_000 },
    async () => {
      for (const mode of ["wrong-heading", "malformed-output"] as const) {
        const context = await makeContext(mode);
        await seedKey(context);

        const started = await verifyAgentModel({
          env: context.env,
          storage: context.storage,
        });
        expect(started.status).toBe("started");
        if (started.status !== "started") continue;
        await waitForTerminal(context.storage, started.run.runId);
        await waitForIdle(context.storage);
        const finished = await loadAgentRun(context.storage, started.run.runId);
        expect(finished).toMatchObject({
          status: "completed",
          stopReason: "completed",
          evaluation: { status: "failed" },
        });
        expect(await loadAgentCompatibility(context.storage)).toBeUndefined();
        expect(
          await evaluateAgentGate({
            storage: context.storage,
            env: context.env,
          }),
        ).toMatchObject({ verified: false, reason: "verification-required" });
      }
    },
  );

  it(
    "does not stamp when the browser model changed during the run",
    { timeout: 45_000 },
    async () => {
      const context = await makeContext("slow");
      context.env.AGENT_WORKER_FAKE_DELAY_MS = "1500";
      await seedKey(context);

      const started = await verifyAgentModel({
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;

      await waitForMarkerFile(context.markersDir, "run.json");
      const settings = await loadModelSettings(context.storage);
      await saveModelSettings(
        context.storage,
        updateBrowserSettings(settings, { modelId: "openrouter/other/model" }),
      );

      await waitForTerminal(context.storage, started.run.runId);
      await waitForIdle(context.storage);
      const finished = await loadAgentRun(context.storage, started.run.runId);
      expect(finished?.evaluation.status).toBe("passed");
      expect(await loadAgentCompatibility(context.storage)).toBeUndefined();
      // No stamp exists for the new model, so a fresh verification is required.
      expect(
        await evaluateAgentGate({
          storage: context.storage,
          env: context.env,
        }),
      ).toMatchObject({
        verified: false,
        reason: "verification-required",
        modelId: "openrouter/other/model",
      });
    },
  );

  it(
    "does not stamp when the server-side key changed before the run settled",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("success");
      await seedKey(context);
      const record = makeRecord({ origin: context.origin });
      await saveAgentRun(context.storage, record);

      const staleKeySettler = buildVerificationSettler({
        storage: context.storage,
        env: context.env,
        repoRoot: process.cwd(),
        keyBefore: OTHER_KEY,
        sdkVersionBefore: await readInstalledSdkVersion(),
      });
      const staleOutcome = await staleKeySettler(record);
      expect(staleOutcome).toMatchObject({ stamped: false });
      expect(staleOutcome.skipReason).toMatch(/key changed/);
      expect(await loadAgentCompatibility(context.storage)).toBeUndefined();
      expect(
        (await loadAgentRun(context.storage, record.runId))?.evaluation.status,
      ).toBe("passed");

      const currentKey = await loadOpenRouterKey(context.env);
      expect(currentKey).toBe(TEST_KEY);
      const settler = buildVerificationSettler({
        storage: context.storage,
        env: context.env,
        repoRoot: process.cwd(),
        keyBefore: currentKey,
        sdkVersionBefore: await readInstalledSdkVersion(),
      });
      expect(await settler(record)).toMatchObject({
        stamped: true,
        skipReason: null,
      });
      expect(await loadAgentCompatibility(context.storage)).toMatchObject({
        modelId: record.modelId,
        origin: record.origin,
        vision: "unverified",
      });
    },
  );

  it(
    "does not stamp when the origin or installed SDK no longer matches the run",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("success");
      await seedKey(context);
      const currentKey = await loadOpenRouterKey(context.env);
      const sdkVersion = await readInstalledSdkVersion();

      const foreignOrigin = makeRecord({
        origin: "http://127.0.0.1:3999",
      });
      await saveAgentRun(context.storage, foreignOrigin);
      const originOutcome = await buildVerificationSettler({
        storage: context.storage,
        env: context.env,
        repoRoot: process.cwd(),
        keyBefore: currentKey,
        sdkVersionBefore: sdkVersion,
      })(foreignOrigin);
      expect(originOutcome).toMatchObject({ stamped: false });
      expect(originOutcome.skipReason).toMatch(/origin changed/);
      expect(await loadAgentCompatibility(context.storage)).toBeUndefined();

      const foreignSdk = makeRecord({
        runId: "22222222-2222-4222-8222-222222222222",
        origin: context.origin,
      });
      await saveAgentRun(context.storage, foreignSdk);
      const sdkOutcome = await buildVerificationSettler({
        storage: context.storage,
        env: context.env,
        repoRoot: process.cwd(),
        keyBefore: currentKey,
        sdkVersionBefore: "0.0.0",
      })(foreignSdk);
      expect(sdkOutcome).toMatchObject({ stamped: false });
      expect(sdkOutcome.skipReason).toMatch(/SDK changed/);
      expect(await loadAgentCompatibility(context.storage)).toBeUndefined();
    },
  );

  it(
    "records observed vision evidence only from actual image content",
    { timeout: 45_000 },
    async () => {
      const context = await makeContext("vision");
      await seedKey(context);

      const started = await verifyAgentModel({
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      await waitForTerminal(context.storage, started.run.runId);
      await waitForIdle(context.storage);
      // The evaluation and stamp are persisted inside the supervisor's settle
      // hook before the lock is released, so re-read the settled record.
      const finished = await loadAgentRun(context.storage, started.run.runId);
      expect(finished).toMatchObject({
        evaluation: { status: "passed" },
        imageInputObserved: true,
        vision: "observed",
      });
      expect(await loadAgentCompatibility(context.storage)).toMatchObject({
        vision: "observed",
      });
      expect(
        await evaluateAgentGate({
          storage: context.storage,
          env: context.env,
        }),
      ).toMatchObject({ verified: true, vision: "observed" });
    },
  );

  it(
    "refuses without a key and never creates a run or a stamp",
    { timeout: 30_000 },
    async () => {
      const context = await makeContext("success");
      expect(
        await verifyAgentModel({
          env: context.env,
          storage: context.storage,
        }),
      ).toEqual({ status: "key-required" });
      expect((await listAgentRuns(context.storage)).runs).toHaveLength(0);
      expect(await loadAgentCompatibility(context.storage)).toBeUndefined();
      expect(
        await readLockMetadata(context.storage.path(PAID_JOB_LOCK_SEGMENTS)),
      ).toBeUndefined();
    },
  );

  it(
    "refuses a second verification while one is active",
    { timeout: 45_000 },
    async () => {
      const context = await makeContext("slow");
      await seedKey(context);

      const first = await verifyAgentModel({
        env: context.env,
        storage: context.storage,
      });
      expect(first.status).toBe("started");
      if (first.status !== "started") return;

      expect(
        await verifyAgentModel({
          env: context.env,
          storage: context.storage,
        }),
      ).toEqual({ status: "run-active", runId: first.run.runId });

      await waitForTerminal(context.storage, first.run.runId);
      await waitForIdle(context.storage);
      expect(await loadAgentCompatibility(context.storage)).toBeDefined();
    },
  );

  it(
    "keeps an existing stamp when a fresh verification fails",
    { timeout: 45_000 },
    async () => {
      const context = await makeContext("wrong-heading");
      await seedKey(context);
      await saveAgentCompatibility(context.storage, {
        version: 1,
        modelId: DEFAULT_BROWSER_MODEL_ID,
        sdkVersion: await readInstalledSdkVersion(),
        origin: context.origin,
        verifiedAt: "2026-10-23T00:00:00.000Z",
        vision: "unverified",
      });

      const started = await verifyAgentModel({
        env: context.env,
        storage: context.storage,
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      await waitForTerminal(context.storage, started.run.runId);
      await waitForIdle(context.storage);

      expect(await loadAgentCompatibility(context.storage)).toMatchObject({
        verifiedAt: "2026-10-23T00:00:00.000Z",
      });
    },
  );
});
