import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cancelRoute from "@/app/api/agent/runs/cancel/route";
import * as runsRoute from "@/app/api/agent/runs/route";
import * as statusRoute from "@/app/api/agent/status/route";
import * as verifyRoute from "@/app/api/agent/verify/route";
import {
  loadAgentCompatibility,
  saveAgentCompatibility,
} from "@/server/agent-compatibility";
import {
  AGENT_CANCEL_GRACE_MS,
  AGENT_VERIFICATION_LIMITS,
  AGENT_WATCHDOG_MARGIN_MS,
  readInstalledSdkVersion,
  resetAgentSupervisorForTests,
} from "@/server/agent-manager";
import type { AgentRunSummary } from "@/lib/agent-history";
import {
  isTerminalAgentRunStatus,
  loadAgentRun,
  type AgentRunRecord,
} from "@/server/agent-runs";
import {
  AGENT_SIGKILL_GRACE_MS,
  AGENT_SIGTERM_GRACE_MS,
} from "@/server/agent-group";
import {
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "@/server/credentials";
import { readLockMetadata } from "@/server/lock";
import { DEFAULT_BROWSER_MODEL_ID } from "@/server/model-settings";
import { PAID_JOB_LOCK_SEGMENTS } from "@/server/paid-lock";
import { resetPaidOperationsForTests } from "@/server/paid-operation";
import { createStorage } from "@/server/storage";

const TEST_KEY = "route-test-secret-key-31";
const fakeSdkUrl = new URL(
  "./fixtures/fake-agent-worker-sdk.mjs",
  import.meta.url,
).href;

const tempDirs: string[] = [];
const servers: Server[] = [];
const originalEnv = { ...process.env };
let origin = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function startHealthServer(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, app: "ai-browser-agent-lab" }),
      );
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

function makeRequest(
  path: string,
  body?: unknown,
  options: { readonly originHeader?: string | null } = {},
): Request {
  const headers = new Headers();
  headers.set("host", new URL(origin).host);
  if (options.originHeader !== null) {
    headers.set("origin", options.originHeader ?? origin);
  }
  headers.set("content-type", "application/json");
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`${origin}${path}`, init);
}

interface StatusBody {
  activeRunId: string | null;
  gate: { keyAvailable: boolean; verified: boolean; reason: string };
  runs: AgentRunSummary[];
  corruptRuns: number;
  recovery: {
    status: string;
    unresolvedCount: number;
    unresolved: Array<{ runId: string; outcome: string; lock: string }>;
  } | null;
}

async function getStatus(): Promise<StatusBody> {
  const response = await statusRoute.GET();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    view: {
      activeRunId: string | null;
      gate: StatusBody["gate"];
      history: AgentRunSummary[];
      recovery: StatusBody["recovery"];
    };
    corruptRuns: number;
  };
  return {
    activeRunId: body.view.activeRunId,
    gate: body.view.gate,
    runs: body.view.history,
    corruptRuns: body.corruptRuns,
    recovery: body.view.recovery,
  };
}

async function waitForRun(
  runId: string,
  timeoutMs = 20_000,
): Promise<AgentRunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getStatus();
    const run = status.runs.find((candidate) => candidate.runId === runId);
    // The run reaches a terminal state before the worker process exits; wait
    // for the supervisor to release the run so activeRunId is authoritative.
    if (
      run &&
      isTerminalAgentRunStatus(run.status) &&
      status.activeRunId === null
    ) {
      const persisted = await loadAgentRun(createStorage(), runId);
      if (persisted) return persisted;
    }
    await sleep(25);
  }
  throw new Error("Timed out waiting for the route-started run to finish.");
}

async function waitForPaidLockRelease(timeoutMs = 10_000): Promise<void> {
  const storage = createStorage();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readLockMetadata(
      storage.path(PAID_JOB_LOCK_SEGMENTS),
    ).catch(() => null);
    if (!lock) return;
    await sleep(25);
  }
  throw new Error("Timed out waiting for the paid lock release.");
}

beforeEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  resetAgentSupervisorForTests();
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-routes-"));
  tempDirs.push(base);
  origin = await startHealthServer();
  process.env.DATA_DIR = join(base, "data");
  process.env.LAB_TEST_MODE = "1";
  process.env.APP_ORIGIN = origin;
  process.env.AGENT_WORKER_TEST_SDK = fakeSdkUrl;
  process.env.AGENT_WORKER_FAKE_MODE = "slow";
  process.env.AGENT_WORKER_TEST_MARKERS = join(base, "markers");
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
  process.env = { ...originalEnv };
});

async function seedKeyAndStamp(): Promise<void> {
  const storage = createStorage();
  await setOpenRouterKey(TEST_KEY, { remember: false, env: process.env });
  await saveAgentCompatibility(storage, {
    version: 1,
    modelId: DEFAULT_BROWSER_MODEL_ID,
    sdkVersion: await readInstalledSdkVersion(),
    origin,
    verifiedAt: new Date().toISOString(),
    vision: "unverified",
  });
}

describe("agent run API routes", () => {
  it("requires a same-origin guarded mutation", async () => {
    const response = await runsRoute.POST(
      makeRequest("/api/agent/runs", { task: "Read the heading." }, {
        originHeader: null,
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing-csrf-token");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses task starts without a key", { timeout: 30_000 }, async () => {
    const response = await runsRoute.POST(
      makeRequest("/api/agent/runs", { task: "Read the heading." }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("key-required");

    const status = await getStatus();
    expect(status.gate.keyAvailable).toBe(false);
    expect(status.runs).toHaveLength(0);
    expect(status.activeRunId).toBeNull();
  });

  it(
    "refuses arbitrary tasks until the model is verified, then runs one task",
    { timeout: 45_000 },
    async () => {
      await setOpenRouterKey(TEST_KEY, { remember: false, env: process.env });

      const refused = await runsRoute.POST(
        makeRequest("/api/agent/runs", { task: "Read the heading." }),
      );
      expect(refused.status).toBe(409);
      const refusedBody = (await refused.json()) as {
        error: { code: string };
        reason: string;
      };
      expect(refusedBody.error.code).toBe("verification-required");
      expect(refusedBody.reason).toBe("verification-required");
      expect((await getStatus()).runs).toHaveLength(0);

      const storage = createStorage();
      await saveAgentCompatibility(storage, {
        version: 1,
        modelId: DEFAULT_BROWSER_MODEL_ID,
        sdkVersion: await readInstalledSdkVersion(),
        origin,
        verifiedAt: new Date().toISOString(),
        vision: "unverified",
      });
      expect((await getStatus()).gate.verified).toBe(true);

      const started = await runsRoute.POST(
        makeRequest("/api/agent/runs", {
          task: "Read the main heading.",
          limits: { maxSteps: 12 },
        }),
      );
      expect(started.status).toBe(200);
      const startedBody = (await started.json()) as {
        ok: boolean;
        run: AgentRunRecord;
      };
      expect(startedBody.ok).toBe(true);
      expect(startedBody.run).toMatchObject({
        kind: "task",
        task: `Start at ${origin}.\nRead the main heading.`,
        limits: { maxSteps: 12, timeoutMs: 180_000, maxCostUsd: 1 },
      });
      expect(JSON.stringify(startedBody)).not.toContain(TEST_KEY);

      const duplicate = await runsRoute.POST(
        makeRequest("/api/agent/runs", { task: "Read the footer." }),
      );
      expect(duplicate.status).toBe(409);
      const duplicateBody = (await duplicate.json()) as {
        error: { code: string };
        runId: string;
      };
      expect(duplicateBody.error.code).toBe("run-active");
      expect(duplicateBody.runId).toBe(startedBody.run.runId);

      const finished = await waitForRun(startedBody.run.runId);
      expect(finished.status).toBe("completed");
      expect(finished.steps).toBe(3);
      expect(finished.usage?.estimatedCostUsd).toBe(0.01);

      const status = await getStatus();
      expect(status.activeRunId).toBeNull();
      expect(status.runs.map((run) => run.runId)).toEqual([
        startedBody.run.runId,
      ]);
      expect(status.corruptRuns).toBe(0);
      expect(status.recovery).toBeNull();
      expect(JSON.stringify(status)).not.toContain(TEST_KEY);
    },
  );

  it(
    "reports an unreadable stored key instead of a generic failure",
    { timeout: 30_000 },
    async () => {
      const storage = createStorage();
      await storage.writeFile(["secrets", "openrouter-key"], "short\n");
      const response = await runsRoute.POST(
        makeRequest("/api/agent/runs", { task: "Read the heading." }),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("key-required");
      expect(await storage.listFiles(["agent-runs"])).toHaveLength(0);
    },
  );

  it(
    "cancels an active run cooperatively and rejects unknown or mismatched runs",
    { timeout: 45_000 },
    async () => {
      await seedKeyAndStamp();
      process.env.AGENT_WORKER_FAKE_MODE = "hang";

      const missing = await cancelRoute.POST(
        makeRequest("/api/agent/runs/cancel", { runId: randomUUID() }),
      );
      expect(missing.status).toBe(409);
      expect(
        ((await missing.json()) as { error: { code: string } }).error.code,
      ).toBe("no-active-run");

      const started = await runsRoute.POST(
        makeRequest("/api/agent/runs", { task: "Read the main heading." }),
      );
      expect(started.status).toBe(200);
      const startedBody = (await started.json()) as { run: AgentRunRecord };
      const runId = startedBody.run.runId;

      const mismatched = await cancelRoute.POST(
        makeRequest("/api/agent/runs/cancel", { runId: randomUUID() }),
      );
      expect(mismatched.status).toBe(409);
      const mismatchedBody = (await mismatched.json()) as {
        error: { code: string };
        activeRunId: string;
      };
      expect(mismatchedBody.error.code).toBe("run-mismatch");
      expect(mismatchedBody.activeRunId).toBe(runId);
      expect(
        (await runsRoute.POST(
          makeRequest("/api/agent/runs", { task: "Read the footer." }),
        )).status,
      ).toBe(409);

      const cancelled = await cancelRoute.POST(
        makeRequest("/api/agent/runs/cancel", { runId }),
      );
      expect(cancelled.status).toBe(200);
      expect((await cancelled.json()) as { ok: boolean }).toMatchObject({
        ok: true,
        runId,
      });

      const finished = await waitForRun(runId);
      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "cancelled",
        cancelReason: "user",
      });
      expect(JSON.stringify(finished)).not.toContain(TEST_KEY);
    },
  );

  it(
    "reports a hung run as needing forced cleanup instead of a cancel",
    { timeout: 45_000 },
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let runId = "";
      let pid = 0;
      try {
        await seedKeyAndStamp();
        process.env.AGENT_WORKER_FAKE_MODE = "hang-forever";

        const started = await runsRoute.POST(
          makeRequest("/api/agent/runs", {
            task: "Read the main heading.",
            limits: { timeoutMs: 10_000 },
          }),
        );
        expect(started.status).toBe(200);
        const startedBody = (await started.json()) as { run: AgentRunRecord };
        runId = startedBody.run.runId;
        pid = startedBody.run.worker?.pid ?? 0;
        expect(pid).toBeGreaterThan(0);

        await vi.advanceTimersByTimeAsync(
          10_000 + AGENT_WATCHDOG_MARGIN_MS + AGENT_CANCEL_GRACE_MS,
        );

        const cancelled = await cancelRoute.POST(
          makeRequest("/api/agent/runs/cancel", { runId }),
        );
        expect(cancelled.status).toBe(409);
        const cancelledBody = (await cancelled.json()) as {
          error: { code: string };
        };
        expect(cancelledBody.error.code).toBe("run-hung");

        // The supervisor force-terminates the verified group itself; drive
        // the faked termination graces until the run settles.
        const deadline = Date.now() + 20_000;
        const storage = createStorage();
        let record = await loadAgentRun(storage, runId);
        while (
          Date.now() < deadline &&
          record !== undefined &&
          !isTerminalAgentRunStatus(record.status)
        ) {
          await vi.advanceTimersByTimeAsync(
            AGENT_SIGTERM_GRACE_MS + AGENT_SIGKILL_GRACE_MS,
          );
          const realUntil = Date.now() + 100;
          while (Date.now() < realUntil) {
            await new Promise<void>((resolvePromise) =>
              setImmediate(resolvePromise),
            );
          }
          record = await loadAgentRun(storage, runId);
        }
        expect(record?.status).toBe("failed");
      } finally {
        vi.useRealTimers();
      }

      expect(pid).toBeGreaterThan(0);
      // The supervisor may still be finishing its verified post-exit scan.
      let status = await getStatus();
      const releaseDeadline = Date.now() + 10_000;
      while (Date.now() < releaseDeadline && status.activeRunId !== null) {
        await sleep(50);
        status = await getStatus();
      }
      expect(status.activeRunId).toBeNull();
      const hung = await loadAgentRun(createStorage(), runId);
      expect(hung?.watchdogExpiredAt).not.toBeNull();
      expect(hung?.status).toBe("failed");
      expect(hung?.error).toMatch(/force-terminated|exited before reporting/);
    },
  );

  it(
    "validates the task body before starting anything",
    { timeout: 30_000 },
    async () => {
      await seedKeyAndStamp();
      const empty = await runsRoute.POST(
        makeRequest("/api/agent/runs", { task: "   " }),
      );
      expect(empty.status).toBe(422);
      const invalidLimits = await runsRoute.POST(
        makeRequest("/api/agent/runs", {
          task: "Read the heading.",
          limits: { maxSteps: 500 },
        }),
      );
      expect(invalidLimits.status).toBe(422);
      const extended = await runsRoute.POST(
        makeRequest("/api/agent/runs", {
          task: "Read the heading.",
          unexpected: true,
        }),
      );
      expect(extended.status).toBe(422);
      expect((await getStatus()).runs).toHaveLength(0);
    },
  );
});

describe("agent verification API route", () => {
  it("requires a guarded, explicit cost confirmation and a key", async () => {
    const missingOrigin = await verifyRoute.POST(
      makeRequest("/api/agent/verify", { confirmCost: true }, {
        originHeader: null,
      }),
    );
    expect(missingOrigin.status).toBe(403);
    expect(
      ((await missingOrigin.json()) as { error: { code: string } }).error.code,
    ).toBe("missing-csrf-token");

    const unconfirmed = await verifyRoute.POST(
      makeRequest("/api/agent/verify", {}),
    );
    expect(unconfirmed.status).toBe(422);
    expect(
      ((await unconfirmed.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid-body");

    const noKey = await verifyRoute.POST(
      makeRequest("/api/agent/verify", { confirmCost: true }),
    );
    expect(noKey.status).toBe(409);
    expect(
      ((await noKey.json()) as { error: { code: string } }).error.code,
    ).toBe("key-required");

    const status = await getStatus();
    expect(status.gate.verified).toBe(false);
    expect(status.runs).toHaveLength(0);
    expect(status.activeRunId).toBeNull();
  });

  it(
    "stamps the tuple after the fixed heading job and unlocks live tasks",
    { timeout: 45_000 },
    async () => {
      await setOpenRouterKey(TEST_KEY, { remember: false, env: process.env });

      const started = await verifyRoute.POST(
        makeRequest("/api/agent/verify", { confirmCost: true }),
      );
      expect(started.status).toBe(200);
      const startedBody = (await started.json()) as {
        ok: boolean;
        run: AgentRunRecord;
      };
      expect(startedBody.ok).toBe(true);
      expect(startedBody.run).toMatchObject({
        kind: "verification",
        status: "running",
        limits: AGENT_VERIFICATION_LIMITS,
      });
      expect(startedBody.run.task).toContain(`${origin}/shop`);
      expect(JSON.stringify(startedBody)).not.toContain(TEST_KEY);

      const duplicate = await verifyRoute.POST(
        makeRequest("/api/agent/verify", { confirmCost: true }),
      );
      expect(duplicate.status).toBe(409);
      const duplicateBody = (await duplicate.json()) as {
        error: { code: string };
        runId: string;
      };
      expect(duplicateBody.error.code).toBe("run-active");
      expect(duplicateBody.runId).toBe(startedBody.run.runId);

      const finished = await waitForRun(startedBody.run.runId);
      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "completed",
        outputText: '{"heading":"Shop"}',
        evaluation: { status: "passed" },
      });

      const stamp = await loadAgentCompatibility(createStorage());
      expect(stamp).toMatchObject({
        modelId: DEFAULT_BROWSER_MODEL_ID,
        sdkVersion: await readInstalledSdkVersion(),
        origin,
        vision: "unverified",
      });

      const verifiedStatus = await getStatus();
      expect(verifiedStatus.gate).toMatchObject({
        verified: true,
        reason: "verified",
        vision: "unverified",
      });
      expect(JSON.stringify(verifiedStatus)).not.toContain(TEST_KEY);

      await waitForPaidLockRelease();
      const task = await runsRoute.POST(
        makeRequest("/api/agent/runs", { task: "Read the main heading." }),
      );
      expect(task.status).toBe(200);
      const taskBody = (await task.json()) as { run: AgentRunRecord };
      await waitForRun(taskBody.run.runId);
    },
  );

  it(
    "starts a preset catalog task and persists its evaluation",
    { timeout: 45_000 },
    async () => {
      await seedKeyAndStamp();
      const response = await runsRoute.POST(
        makeRequest("/api/agent/runs", { presetId: "catalog-out-of-stock" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { run: AgentRunRecord };
      expect(body.run).toMatchObject({
        kind: "task",
        presetId: "catalog-out-of-stock",
        status: "running",
        evaluation: { status: "not_evaluated", reason: null },
      });
      expect(body.run.task).toContain(`${origin}/shop`);

      const finished = await waitForRun(body.run.runId);
      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "completed",
        presetId: "catalog-out-of-stock",
        evaluation: { status: "passed" },
        uiEvidence: "observed",
      });
      expect(finished.outputText).toContain("Atlas Travel Backpack");
    },
  );

  it(
    "starts a form preset and persists its baseline and evaluation",
    { timeout: 45_000 },
    async () => {
      await seedKeyAndStamp();
      const response = await runsRoute.POST(
        makeRequest("/api/agent/runs", { presetId: "form-support-request" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { run: AgentRunRecord };
      expect(body.run).toMatchObject({
        kind: "task",
        presetId: "form-support-request",
        formBaseline: null,
        status: "running",
        evaluation: { status: "not_evaluated", reason: null },
      });
      expect(body.run.task).toContain(`${origin}/forms/support`);
      const persisted = await loadAgentRun(createStorage(), body.run.runId);
      expect(persisted?.formBaseline).toEqual({
        form: "support",
        submissionIds: [],
      });

      const finished = await waitForRun(body.run.runId);
      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "completed",
        presetId: "form-support-request",
        evaluation: { status: "passed" },
      });
      const output = JSON.parse(finished.outputText ?? "{}") as {
        requestId?: string;
      };
      expect(output.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    },
  );

  it("refuses a start body with both a task and a preset", async () => {
    const response = await runsRoute.POST(
      makeRequest("/api/agent/runs", {
        task: "Read the heading.",
        presetId: "catalog-cheapest-home",
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid-body");

    const unknownPreset = await runsRoute.POST(
      makeRequest("/api/agent/runs", { presetId: "catalog-unknown" }),
    );
    expect(unknownPreset.status).toBe(422);
    const unknownBody = (await unknownPreset.json()) as {
      error: { code: string };
    };
    expect(unknownBody.error.code).toBe("invalid-body");
  });

  it(
    "leaves the model unverified when the heading answer does not match",
    { timeout: 45_000 },
    async () => {
      process.env.AGENT_WORKER_FAKE_MODE = "wrong-heading";
      await setOpenRouterKey(TEST_KEY, { remember: false, env: process.env });

      const started = await verifyRoute.POST(
        makeRequest("/api/agent/verify", { confirmCost: true }),
      );
      expect(started.status).toBe(200);
      const startedBody = (await started.json()) as { run: AgentRunRecord };

      const finished = await waitForRun(startedBody.run.runId);
      expect(finished).toMatchObject({
        status: "completed",
        stopReason: "completed",
        evaluation: { status: "failed" },
      });
      expect(finished.evaluation.reason).toContain("Storefront");
      expect(await loadAgentCompatibility(createStorage())).toBeUndefined();
      const status = await getStatus();
      expect(status.gate).toMatchObject({
        verified: false,
        reason: "verification-required",
      });
    },
  );
});
