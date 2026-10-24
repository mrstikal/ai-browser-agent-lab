import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Runs first (sorted by file name) because the shared dev server loads the
 * session key lazily: seeding `data/secrets/openrouter-key` before any
 * key-reading request lets this spec prove the browser-based verification and
 * the supervisor strategy next to a real Next.js dev server. The second test
 * deletes the key again through the guarded route so later setup tests see a
 * fresh state.
 */

const TEST_KEY = "e2e-supervisor-secret-key-59";

async function seedKeyFile(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, "secrets", "openrouter-key"), `${TEST_KEY}\n`, {
    mode: 0o600,
  });
}

async function writeCompatibilityStamp(
  dataDir: string,
  origin: string,
): Promise<void> {
  const sdkManifest = JSON.parse(
    await readFile(
      join(process.cwd(), "node_modules", "@browser_use", "pi", "package.json"),
      "utf8",
    ),
  ) as { version: string };
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
}

test("the Verify Agent Model action stamps the fixed Shop heading run", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  const origin = baseURL;

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
  await rm(join(dataDir, "agent-compatibility.json"), { force: true });

  const before = await request.get("/api/agent/status");
  expect(before.status()).toBe(200);
  const beforeBody = (await before.json()) as {
    activeRunId: string | null;
    gate: { keyAvailable: boolean; verified: boolean; reason: string };
    runs: Array<{ status: string }>;
  };
  expect(beforeBody.gate).toMatchObject({
    keyAvailable: true,
    verified: false,
    reason: "verification-required",
  });
  expect(beforeBody.activeRunId).toBeNull();
  // A retried attempt may leave completed runs behind; none may be active.
  expect(beforeBody.runs.every((run) => run.status !== "running")).toBe(true);

  await page.goto("/agent");
  await expect(page.getByTestId("verification-cost-warning")).toContainText(
    "$0.25",
  );
  await expect(page.getByTestId("verification-state")).toContainText(
    "Verification is required",
  );
  const button = page.getByTestId("verify-agent-model");
  await expect(button).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(button).toBeEnabled();
  const runStartedAt = Date.now();
  await button.click();

  await expect(page.getByTestId("verification-result")).toContainText(
    "The Shop heading check passed",
    { timeout: 45_000 },
  );
  await expect(page.getByTestId("verification-state")).toContainText(
    "Verified at",
  );
  await expect(page.getByTestId("verification-vision")).toContainText(
    "Unverified",
  );

  const stamp = JSON.parse(
    await readFile(join(dataDir, "agent-compatibility.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(stamp).toMatchObject({
    version: 1,
    modelId: "openrouter/openai/gpt-5.6-luna",
    sdkVersion: sdkManifest.version,
    origin,
    vision: "unverified",
  });
  // The stamp must come from this attempt, not a retried attempt's leftover.
  expect(Date.parse(String(stamp.verifiedAt))).toBeGreaterThanOrEqual(
    runStartedAt,
  );

  const after = await request.get("/api/agent/status");
  const afterBody = (await after.json()) as {
    gate: { verified: boolean; vision: string };
    runs: Array<{ kind: string; evaluation: { status: string } }>;
  };
  expect(afterBody.gate).toMatchObject({ verified: true, vision: "unverified" });
  expect(
    afterBody.runs.find((run) => run.kind === "verification")?.evaluation.status,
  ).toBe("passed");
  expect(JSON.stringify(afterBody)).not.toContain(TEST_KEY);
});

test("dashboard task controls start a run without claiming task success", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  await seedKeyFile(dataDir);
  await writeCompatibilityStamp(dataDir, baseURL);

  await page.goto("/agent");
  await expect(page.getByTestId("agent-model-notice")).toContainText(
    "openrouter/openai/gpt-5.6-luna",
  );
  await expect(page.getByTestId("agent-limits-notice")).toContainText(
    "30 steps",
  );
  await expect(page.getByTestId("agent-limits-notice")).toContainText("$1.00");

  const runButton = page.getByTestId("agent-run-task");
  await expect(runButton).toBeDisabled();
  await page.getByTestId("agent-task-input").fill("Read the main heading.");
  await expect(runButton).toBeEnabled();
  await runButton.click();

  await expect(page.getByTestId("agent-run-execution")).toHaveText(
    "Execution completed",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("agent-run-stop-reason")).toHaveText(
    "The SDK completed the run.",
  );
  await expect(page.getByTestId("agent-run-task-result")).toContainText(
    "Not evaluated",
  );
  await expect(page.getByTestId("agent-run-task-result")).not.toContainText(
    "Task passed",
  );
  await expect(page.getByTestId("agent-run-output")).toContainText(
    '{"heading":"Shop"}',
  );
  await expect(runButton).toBeEnabled({ timeout: 15_000 });
});

test("dashboard refuses a duplicate run and renders cancellation", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  await seedKeyFile(dataDir);
  await writeCompatibilityStamp(dataDir, baseURL);

  await page.goto("/agent");
  const input = page.getByTestId("agent-task-input");
  const runButton = page.getByTestId("agent-run-task");
  await input.fill("Hold the run [[cancel]]");
  await runButton.click();

  await expect(page.getByTestId("agent-run-execution")).toHaveText("Running", {
    timeout: 15_000,
  });
  await expect(runButton).toBeDisabled();
  await expect(page.getByTestId("agent-run-active-note")).toContainText(
    "already active",
  );

  const duplicate = await request.post("/api/agent/runs", {
    data: { task: "Second task" },
    headers: { origin: baseURL },
  });
  expect(duplicate.status()).toBe(409);
  expect(
    ((await duplicate.json()) as { error: { code: string } }).error.code,
  ).toBe("run-active");

  await page.getByTestId("agent-cancel-run").click();
  await expect(page.getByTestId("agent-run-execution")).toHaveText(
    "Execution stopped (cancelled)",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("agent-run-task-result")).toContainText(
    "Not evaluated",
  );
  await expect(runButton).toBeEnabled({ timeout: 15_000 });

  const marker = JSON.parse(
    await readFile(join(dataDir, "agent-test-markers", "cancel.json"), "utf8"),
  ) as { cancelCount: number };
  expect(marker.cancelCount).toBeGreaterThan(0);
  expect(await page.content()).not.toContain(TEST_KEY);
});

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
      activeRunId: string | null;
      gate: { keyAvailable: boolean; verified: boolean };
      runs: Array<{ status: string }>;
    };
    expect(beforeBody.gate.keyAvailable).toBe(true);
    expect(beforeBody.gate.verified).toBe(true);
    expect(beforeBody.activeRunId).toBeNull();
    expect(beforeBody.runs.every((run) => run.status !== "running")).toBe(true);

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
