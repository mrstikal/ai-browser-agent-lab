import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Runs first (sorted by file name) because the shared dev server loads the
 * session key lazily: seeding `data/secrets/openrouter-key` and a matching
 * compatibility stamp before any key-reading request lets this spec prove the
 * supervisor strategy next to a real Next.js dev server. The spec deletes the
 * key again through the guarded route so later setup tests see a fresh state.
 */

const TEST_KEY = "e2e-supervisor-secret-key-59";

test("a mocked supervised run works beside the dev server", async ({
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  const origin = baseURL;
  const headers = { origin };

  const sdkManifest = JSON.parse(
    await readFile(
      join(process.cwd(), "node_modules", "@browser_use", "pi", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  await mkdir(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, "secrets", "openrouter-key"), `${TEST_KEY}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(dataDir, "agent-compatibility.json"),
    `${JSON.stringify(
      {
        version: 1,
        modelId: "openrouter/openai/gpt-5.6-luna",
        sdkVersion: sdkManifest.version,
        origin,
        verifiedAt: new Date().toISOString(),
        vision: "unverified",
      },
      null,
      2,
    )}\n`,
  );

  try {
    const before = await request.get("/api/agent/status");
    expect(before.status()).toBe(200);
    const beforeBody = (await before.json()) as {
      gate: { keyAvailable: boolean; verified: boolean };
      runs: unknown[];
    };
    expect(beforeBody.gate.keyAvailable).toBe(true);
    expect(beforeBody.gate.verified).toBe(true);
    expect(beforeBody.runs).toHaveLength(0);

    const started = await request.post("/api/agent/runs", {
      data: { task: "Read the main heading." },
      headers,
    });
    expect(started.status()).toBe(200);
    const startedBody = (await started.json()) as {
      run: {
        runId: string;
        status: string;
        limits: unknown;
        worker: { pid: number; groupId: number } | null;
      };
    };
    expect(startedBody.run.status).toBe("running");
    expect(startedBody.run.limits).toEqual({
      maxSteps: 30,
      timeoutMs: 180_000,
      maxCostUsd: 1,
    });
    expect(startedBody.run.worker?.pid).toBeGreaterThan(0);
    expect(startedBody.run.worker?.groupId).toBe(startedBody.run.worker?.pid);
    expect(JSON.stringify(startedBody)).not.toContain(TEST_KEY);

    await expect
      .poll(
        async () => {
          const response = await request.get("/api/agent/status");
          const body = (await response.json()) as {
            runs: Array<{ runId: string; status: string }>;
          };
          return (
            body.runs.find((run) => run.runId === startedBody.run.runId)
              ?.status ?? "missing"
          );
        },
        { timeout: 30_000, intervals: [100, 250, 500] },
      )
      .toBe("completed");

    await expect
      .poll(
        async () => {
          const response = await request.get("/api/agent/status");
          const body = (await response.json()) as { activeRunId: string | null };
          return body.activeRunId;
        },
        { timeout: 15_000, intervals: [100, 250, 500] },
      )
      .toBeNull();

    const after = await request.get("/api/agent/status");
    expect(after.status()).toBe(200);
    const afterBody = (await after.json()) as {
      activeRunId: string | null;
      runs: Array<{
        runId: string;
        status: string;
        stopReason: string | null;
        steps: number | null;
        outputText: string | null;
        evaluation: { status: string };
        uiEvidence: string;
      }>;
    };
    const run = afterBody.runs.find(
      (candidate) => candidate.runId === startedBody.run.runId,
    );
    expect(run).toMatchObject({
      status: "completed",
      stopReason: "completed",
      steps: 3,
      outputText: '{"heading":"Shop"}',
      evaluation: { status: "not_evaluated" },
      uiEvidence: "unverified",
    });
    expect(afterBody.activeRunId).toBeNull();
    expect(JSON.stringify(afterBody)).not.toContain(TEST_KEY);
  } finally {
    // Cleanup must not mask the primary assertion if the run is still active:
    // a guarded delete returns 409 while the paid-operation flag is held.
    try {
      await request.delete("/api/setup/key", { data: {}, headers });
    } catch {
      // Best effort; the server's session ends with the E2E run anyway.
    }
    await rm(join(dataDir, "agent-compatibility.json"), { force: true });
  }
});
