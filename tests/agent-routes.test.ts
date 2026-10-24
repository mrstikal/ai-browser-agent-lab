import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as runsRoute from "@/app/api/agent/runs/route";
import * as statusRoute from "@/app/api/agent/status/route";
import { saveAgentCompatibility } from "@/server/agent-compatibility";
import {
  readInstalledSdkVersion,
  resetAgentSupervisorForTests,
} from "@/server/agent-manager";
import type { AgentRunRecord } from "@/server/agent-runs";
import {
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "@/server/credentials";
import { DEFAULT_BROWSER_MODEL_ID } from "@/server/model-settings";
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
  runs: AgentRunRecord[];
  corruptRuns: number;
}

async function getStatus(): Promise<StatusBody> {
  const response = await statusRoute.GET();
  expect(response.status).toBe(200);
  return (await response.json()) as StatusBody;
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
    if (run && run.status !== "running" && status.activeRunId === null) {
      return run;
    }
    await sleep(25);
  }
  throw new Error("Timed out waiting for the route-started run to finish.");
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
        task: "Read the main heading.",
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
