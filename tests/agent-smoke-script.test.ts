import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentCompatibility } from "../src/server/agent-compatibility";
import { readLockMetadata } from "../src/server/lock";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];
const servers: Server[] = [];
const originalEnv = { ...process.env };
const fakeSdkUrl = new URL(
  "./fixtures/fake-browser-use.mjs",
  import.meta.url,
).href;

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-smoke-script-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startHealthServer(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      json(response, 200, { ok: true, app: "ai-browser-agent-lab" });
      return;
    }
    json(response, 404, { error: { code: "not-found" } });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

interface SmokeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: Record<string, unknown>;
}

function runSmoke(
  args: readonly string[],
  env: Record<string, string>,
  expectResult = true,
): Promise<SmokeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/agent-model-smoke.ts", ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Smoke timed out. stdout=${stdout} stderr=${stderr}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const match = /SMOKE_RESULT (\{.*\})/.exec(stdout);
      if (!match?.[1]) {
        if (expectResult) {
          reject(new Error(`Missing SMOKE_RESULT. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        resolve({ code, stdout, stderr, result: {} });
        return;
      }
      resolve({
        code,
        stdout,
        stderr,
        result: JSON.parse(match[1]) as Record<string, unknown>,
      });
    });
  });
}

beforeEach(async () => {
  originalEnv.APP_ORIGIN = process.env.APP_ORIGIN;
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  process.env = { ...originalEnv };
});

function fakeEnv(
  storage: Storage,
  origin: string,
  mode: string,
): Record<string, string> {
  return {
    APP_ORIGIN: origin,
    DATA_DIR: storage.root,
    LAB_TEST_MODE: "1",
    AGENT_SMOKE_TEST_SDK: fakeSdkUrl,
    AGENT_SMOKE_FAKE_MODE: mode,
  };
}

describe("agent model smoke live observations (mocked SDK)", () => {
  it("stamps the app after one approved heading observation with the remembered key", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();
    const run = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      fakeEnv(storage, origin, "success"),
    );

    expect(run.code).toBe(0);
    expect(run.result).toMatchObject({
      status: "Verified",
      paidObservations: 1,
      stampWritten: true,
      vision: "unverified",
      domainPolicy: "blocked",
    });
    const stamp = await loadAgentCompatibility(storage);
    expect(stamp).toMatchObject({
      modelId: "openrouter/openai/gpt-5.6-luna",
      vision: "unverified",
      origin,
    });
    expect(
      await readLockMetadata(storage.path(["locks", "paid-job.lock"])),
    ).toBeUndefined();
    expect(run.stdout).not.toContain("sk-or-v1-remembered");
  });

  it("labels vision observed only from mock image tool events", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();
    const run = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      fakeEnv(storage, origin, "vision"),
    );
    expect(run.result).toMatchObject({
      status: "Verified",
      vision: "observed",
      stampWritten: true,
    });
    expect((await loadAgentCompatibility(storage))?.vision).toBe("observed");
  });

  it("requires a separate approval for the second observation", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();

    const firstOnly = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      fakeEnv(storage, origin, "fail-then-success"),
    );
    expect(firstOnly.result).toMatchObject({
      status: "Partial - Unverified",
      paidObservations: 1,
      stampWritten: false,
    });
    expect(await loadAgentCompatibility(storage)).toBeUndefined();

    const second = await runSmoke(
      [
        "--live",
        "--approve-paid",
        "--approve-observation=1",
        "--approve-observation=2",
      ],
      fakeEnv(storage, origin, "fail-then-success"),
    );
    expect(second.result).toMatchObject({
      status: "Verified",
      paidObservations: 2,
      stampWritten: true,
    });
  });

  it("blocks when domain enforcement is absent and never stamps", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();
    const run = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      fakeEnv(storage, origin, "domain-open"),
    );
    expect(run.code).toBe(1);
    expect(run.result).toMatchObject({
      status: "Blocked",
      domainPolicy: "not-blocked",
      stampWritten: false,
    });
    expect(await loadAgentCompatibility(storage)).toBeUndefined();
  });

  it("blocks SDK incompatibility and redacts key-shaped error text", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();
    const blocked = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      fakeEnv(storage, origin, "blocked"),
    );
    expect(blocked.result).toMatchObject({ status: "Blocked", stampWritten: false });

    const keyError = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      fakeEnv(storage, origin, "blocked-key"),
    );
    expect(keyError.stdout).not.toContain("sk-or-v1-remembered");
    expect(JSON.stringify(keyError.result)).toContain("[redacted]");
    expect(await loadAgentCompatibility(storage)).toBeUndefined();
  });

  it("turns a Chromium launch failure into actionable Blocked guidance", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();

    const noDisplay = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      { ...fakeEnv(storage, origin, "success"), DISPLAY: "", WAYLAND_DISPLAY: "" },
    );
    expect(noDisplay.code).toBe(1);
    expect(noDisplay.result).toMatchObject({
      status: "Blocked",
      paidObservations: 0,
      stampWritten: false,
    });
    expect(String(noDisplay.result.reason)).toContain("WSLg");

    const headless = await runSmoke(
      [
        "--live",
        "--approve-paid",
        "--approve-observation=1",
        "--headless",
      ],
      fakeEnv(storage, origin, "chrome-exit"),
    );
    expect(headless.code).toBe(1);
    expect(headless.result).toMatchObject({
      status: "Blocked",
      paidObservations: 0,
      stampWritten: false,
    });
    expect(String(headless.result.reason)).toContain(
      "check that Chrome can start",
    );
  });

  it("survives a mock run with missing usage data", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();
    const run = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      fakeEnv(storage, origin, "missing-usage"),
    );
    expect(run.result).toMatchObject({
      status: "Verified",
      stampWritten: true,
    });
    const observations = run.result.observations as Array<{
      tokens: { total: number | null };
      estimatedCostUsd: number | null;
    }>;
    expect(observations[0]).toMatchObject({
      tokens: { input: null, output: null, total: null },
      estimatedCostUsd: null,
    });
  });
});

describe("agent model smoke preflight", () => {
  it("reports Partial - Unverified with zero paid calls when live is not requested", async () => {
    const storage = await makeStorage();
    const origin = await startHealthServer();
    const run = await runSmoke([], {
      APP_ORIGIN: origin,
      DATA_DIR: storage.root,
    });
    expect(run.code).toBe(0);
    expect(run.result).toMatchObject({
      status: "Partial - Unverified",
      paidObservations: 0,
      stampWritten: false,
      vision: "unverified",
      domainPolicy: "unverified",
      appHealth: "ok",
    });
    expect(await loadAgentCompatibility(storage)).toBeUndefined();
    expect(
      await readLockMetadata(storage.path(["locks", "paid-job.lock"])),
    ).toBeUndefined();
  });

  it("refuses a live run without --approve-paid and sends no SDK work", async () => {
    const storage = await makeStorage();
    const origin = await startHealthServer();
    const run = await runSmoke(["--live", "--approve-observation=1"], {
      APP_ORIGIN: origin,
      DATA_DIR: storage.root,
    });
    expect(run.code).toBe(0);
    expect(run.result).toMatchObject({
      status: "Partial - Unverified",
      paidObservations: 0,
      stampWritten: false,
      reason: expect.stringContaining("not approved"),
    });
    expect(
      await readLockMetadata(storage.path(["locks", "paid-job.lock"])),
    ).toBeUndefined();
  });

  it("does not stamp a remembered key without a live observation", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-remembered");
    const origin = await startHealthServer();
    const run = await runSmoke([], {
      APP_ORIGIN: origin,
      DATA_DIR: storage.root,
    });
    expect(run.result).toMatchObject({
      status: "Partial - Unverified",
      keySource: "app",
      keyAvailable: true,
      usedRememberedKey: true,
      stampWritten: false,
    });
    expect(run.stdout).not.toContain("sk-or-v1-remembered");
    expect(await loadAgentCompatibility(storage)).toBeUndefined();
  });

  it("reports a live run without any key as Partial and never launches the SDK", async () => {
    const storage = await makeStorage();
    const origin = await startHealthServer();
    const run = await runSmoke(
      ["--live", "--approve-paid", "--approve-observation=1"],
      {
        APP_ORIGIN: origin,
        DATA_DIR: storage.root,
      },
    );
    expect(run.code).toBe(0);
    expect(run.result).toMatchObject({
      status: "Partial - Unverified",
      paidObservations: 0,
      keyAvailable: false,
      stampWritten: false,
    });
    expect(
      await readLockMetadata(storage.path(["locks", "paid-job.lock"])),
    ).toBeUndefined();
    expect(await loadAgentCompatibility(storage)).toBeUndefined();
  });

  it("requires the running app health marker before any SDK work", async () => {
    const storage = await makeStorage();
    const run = await runSmoke(
      [],
      {
        APP_ORIGIN: "http://127.0.0.1:1",
        DATA_DIR: storage.root,
      },
      false,
    );
    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain("SMOKE_RESULT");
    expect(run.stderr).toContain("did not return the app marker");
  });

  it("prints the documented limits without requiring the app", async () => {
    const storage = await makeStorage();
    const run = await runSmoke(
      ["--help"],
      {
        APP_ORIGIN: "http://127.0.0.1:1",
        DATA_DIR: storage.root,
      },
      false,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("maxSteps 8");
    expect(run.stdout).toContain("timeout 120000 ms");
    expect(run.stdout).toContain("--key-source=tty");
    expect(run.stdout).toContain("--approve-observation=1");
  });
});
