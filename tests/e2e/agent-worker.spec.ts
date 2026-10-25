import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Runs first (sorted by file name) because the shared dev server loads the
 * session key lazily: seeding `data/secrets/openrouter-key` before any
 * key-reading request lets this spec prove the browser-based verification and
 * the supervisor strategy next to a real Next.js dev server. The final test
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
    view: {
      activeRunId: string | null;
      gate: { keyAvailable: boolean; verified: boolean; reason: string };
      history: Array<{ status: string }>;
    };
  };
  expect(beforeBody.view.gate).toMatchObject({
    keyAvailable: true,
    verified: false,
    reason: "verification-required",
  });
  expect(beforeBody.view.activeRunId).toBeNull();
  // A retried attempt may leave completed runs behind; none may be active.
  expect(
    beforeBody.view.history.every((run) => run.status !== "running"),
  ).toBe(true);

  await page.goto("/agent");
  await expect(page.getByTestId("verification-cost-warning")).toContainText(
    "$0.25",
  );
  await expect(page.getByTestId("verification-state")).toContainText(
    "Verification is required",
  );
  const button = page.getByTestId("verify-agent-model");
  await expect(button).toBeDisabled();
  await page.getByTestId("verification-cost-confirm").check();
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
    view: {
      gate: { verified: boolean; vision: string };
      history: Array<{ kind: string; evaluation: { status: string } }>;
    };
  };
  expect(afterBody.view.gate).toMatchObject({
    verified: true,
    vision: "unverified",
  });
  expect(
    afterBody.view.history.find((run) => run.kind === "verification")
      ?.evaluation.status,
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
  await expect(page.getByTestId("agent-run-overall")).toHaveCount(0);
  await expect(runButton).toBeEnabled({ timeout: 15_000 });

  await expect(page.getByTestId("agent-trace-connection")).toHaveText("Live", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("agent-trace-count")).toHaveText("5", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("agent-trace-step")).toHaveText("1");
  await expect(page.getByTestId("agent-trace-errors")).toHaveText("0");
  await expect(page.getByTestId("agent-trace-latest-action")).toContainText(
    "Agent finished",
  );
  await expect(page.getByTestId("agent-trace-image")).toHaveText(
    "Not observed",
  );
  const traceRows = page.getByTestId("agent-trace-event");
  await expect(traceRows).toHaveCount(5);
  const readSeqs = async (): Promise<(string | null)[]> =>
    traceRows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-seq")),
    );
  expect(await readSeqs()).toEqual(["1", "2", "3", "4", "5"]);

  // A refresh replays the persisted trace through the server-rendered initial
  // state and the SSE reset; the rows must not duplicate.
  await page.reload();
  await expect(page.getByTestId("agent-trace-count")).toHaveText("5", {
    timeout: 15_000,
  });
  await expect(traceRows).toHaveCount(5);
  expect(await readSeqs()).toEqual(["1", "2", "3", "4", "5"]);

  // A dropped stream must fall back cleanly and reconnect without
  // duplicating already-seen events.
  await page.route("**/api/agent/stream", (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId("agent-trace-connection")).toContainText(
    "Reconnecting",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("agent-trace-count")).toHaveText("5");
  await page.unroute("**/api/agent/stream");
  await expect(page.getByTestId("agent-trace-connection")).toHaveText("Live", {
    timeout: 30_000,
  });
  await expect(traceRows).toHaveCount(5);
  expect(await readSeqs()).toEqual(["1", "2", "3", "4", "5"]);

  const content = await page.content();
  expect(content).not.toContain(TEST_KEY);
  expect(content.toLowerCase()).not.toContain("authorization");
  expect(content.toLowerCase()).not.toContain("cookie");
});

test("trace renders hostile tool names as plain text", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  await seedKeyFile(dataDir);
  await writeCompatibilityStamp(dataDir, baseURL);

  await page.goto("/agent");
  await page.getByTestId("agent-task-input").fill("Read the heading [[xss]]");
  await page.getByTestId("agent-run-task").click();
  await expect(page.getByTestId("agent-run-execution")).toHaveText(
    "Execution completed",
    { timeout: 30_000 },
  );

  const hostile = '<img src=x onerror="alert(1)">';
  const traceEvents = page.getByTestId("agent-trace-events");
  await expect(traceEvents).toContainText(hostile, { timeout: 15_000 });
  await expect(traceEvents.locator("img")).toHaveCount(0);
});

test("history keeps persisted runs, honest usage, and historical traces", async ({
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
  const runTask = async (task: string): Promise<void> => {
    await page.getByTestId("agent-task-input").fill(task);
    await page.getByTestId("agent-run-task").click();
    await expect(page.getByTestId("agent-run-execution")).toHaveText(
      "Execution completed",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("agent-run-task")).toBeEnabled({
      timeout: 15_000,
    });
  };

  await runTask("Read the heading [[xss]]");
  await runTask("Read the main heading after history check.");

  const statusResponse = await request.get("/api/agent/status");
  expect(statusResponse.status()).toBe(200);
  const statusBody = (await statusResponse.json()) as {
    view: { history: Array<{ runId: string; kind: string }> };
  };
  const taskRuns = statusBody.view.history.filter(
    (run) => run.kind === "task",
  );
  const latestRun = taskRuns[0];
  const xssRun = taskRuns[1];
  if (!xssRun || !latestRun) {
    throw new Error("The history test runs were not persisted.");
  }

  const xssItem = page.locator(`[data-run-id="${xssRun.runId}"]`);
  await expect(xssItem).toBeVisible();
  await expect(xssItem.getByTestId("agent-history-execution")).toContainText(
    "Execution completed",
  );
  await expect(xssItem.getByTestId("agent-history-result")).toHaveText(
    "Not evaluated",
  );
  await expect(xssItem.getByTestId("agent-history-ui-evidence")).toHaveText(
    "Observed",
  );
  await expect(xssItem.getByTestId("agent-history-vision")).toHaveText(
    "Unverified",
  );
  await expect(xssItem.getByTestId("agent-history-ui-mode")).toHaveText(
    "Classic",
  );
  await expect(xssItem.getByTestId("agent-history-usage")).toContainText(
    "15 tokens",
  );
  await expect(xssItem.getByTestId("agent-history-usage")).toContainText(
    "$0.01",
  );
  await expect(xssItem.getByTestId("agent-history-model")).toHaveText(
    "openrouter/openai/gpt-5.6-luna",
  );
  await expect(xssItem.getByTestId("agent-history-started")).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
  );
  await expect(xssItem.getByTestId("agent-history-ended")).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
  );
  await expect(xssItem.getByTestId("agent-history-steps")).toHaveText(
    /^\d+ steps · .+$/,
  );
  await expect(xssItem.getByTestId("agent-history-steps")).not.toContainText(
    "unknown",
  );
  await expect(xssItem).not.toContainText("Full task pass");

  await xssItem.getByTestId("agent-history-select").click();
  await expect(page.getByTestId("agent-trace-run")).toContainText(xssRun.runId);
  await expect(page.getByTestId("agent-trace-run")).toContainText(
    "selected from saved history",
  );
  await expect(page.getByTestId("agent-trace-count")).toHaveText("5", {
    timeout: 15_000,
  });
  const hostile = '<img src=x onerror="alert(1)">';
  await expect(page.getByTestId("agent-trace-events")).toContainText(hostile);
  await expect(page.getByTestId("agent-trace-events").locator("img")).toHaveCount(
    0,
  );

  const latestItem = page.locator(`[data-run-id="${latestRun.runId}"]`);
  await expect(latestItem.getByTestId("agent-history-ui-evidence")).toHaveText(
    "Observed",
  );
  await latestItem.getByTestId("agent-history-select").click();
  await expect(page.getByTestId("agent-trace-run")).toContainText(
    latestRun.runId,
  );
  await expect(page.getByTestId("agent-trace-count")).toHaveText("5", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("agent-trace-events")).not.toContainText(
    hostile,
  );

  await page.getByTestId("agent-history-follow").click();
  await expect(page.getByTestId("agent-trace-run")).toContainText(
    latestRun.runId,
  );
  await expect(page.getByTestId("agent-trace-connection")).toHaveText("Live", {
    timeout: 15_000,
  });

  // Seed old records to prove the bounded history survives a page/restart
  // reload and keeps unknown usage and a cancelled preset run honest.
  const baseRecord = {
    version: 2,
    kind: "task",
    presetId: null,
    uiMode: null,
    formBaseline: null,
    modelId: "openrouter/openai/gpt-5.6-luna",
    origin: baseURL,
    limits: { maxSteps: 30, timeoutMs: 180_000, maxCostUsd: 1 },
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
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
  const unknownRunId = randomUUID();
  const cancelledRunId = randomUUID();
  const runsDir = join(dataDir, "agent-runs");
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(runsDir, `${unknownRunId}.json`),
    `${JSON.stringify(
      {
        ...baseRecord,
        runId: unknownRunId,
        task: "Seeded run without SDK usage.",
        uiMode: "alternate",
        startedAt: "2026-01-01T00:02:00.000Z",
        endedAt: "2026-01-01T00:02:05.000Z",
        updatedAt: "2026-01-01T00:02:05.000Z",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(runsDir, `${cancelledRunId}.json`),
    `${JSON.stringify(
      {
        ...baseRecord,
        runId: cancelledRunId,
        presetId: "catalog-cheapest-home",
        task: "Seeded cancelled preset run.",
        stopReason: "cancelled",
        error: "Seeded cancellation reason.",
        startedAt: "2026-01-01T00:01:00.000Z",
        endedAt: "2026-01-01T00:01:05.000Z",
        updatedAt: "2026-01-01T00:01:05.000Z",
        evaluation: {
          status: "passed",
          reason: "The evaluator matched the answer.",
        },
        uiEvidence: "observed",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          estimatedCostUsd: 0.01,
        },
      },
      null,
      2,
    )}\n`,
  );

  await page.reload();
  const unknownItem = page.locator(`[data-run-id="${unknownRunId}"]`);
  await expect(unknownItem).toBeVisible();
  await expect(unknownItem.getByTestId("agent-history-usage")).toContainText(
    "unknown",
  );
  await expect(unknownItem.getByTestId("agent-history-usage")).not.toContainText(
    "$0.00",
  );
  await expect(unknownItem.getByTestId("agent-history-ui-mode")).toHaveText(
    "Alternate",
  );
  await expect(unknownItem.getByTestId("agent-history-error")).toHaveCount(0);

  const cancelledItem = page.locator(`[data-run-id="${cancelledRunId}"]`);
  await expect(cancelledItem).toBeVisible();
  await expect(
    cancelledItem.getByTestId("agent-history-execution"),
  ).toContainText("Execution stopped (cancelled)");
  await expect(cancelledItem.getByTestId("agent-history-result")).toContainText(
    "Business result passed; execution not completed",
  );
  await expect(cancelledItem.getByTestId("agent-history-error")).toContainText(
    "Seeded cancellation reason.",
  );
  await expect(cancelledItem).not.toContainText("Full task pass");
});

test("resilience comparison counts samples and requires confirmation for live repetition", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  await seedKeyFile(dataDir);
  await writeCompatibilityStamp(dataDir, baseURL);

  const modelId = "openrouter/openai/gpt-5.6-luna";
  const baseRecord = {
    version: 2,
    kind: "task",
    presetId: "catalog-cheapest-home",
    uiMode: "classic",
    formBaseline: null,
    modelId,
    origin: baseURL,
    limits: { maxSteps: 30, timeoutMs: 180_000, maxCostUsd: 1 },
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-01-02T00:00:00.000Z",
    endedAt: "2026-01-02T00:00:05.000Z",
    updatedAt: "2026-01-02T00:00:05.000Z",
    steps: 3,
    durationMs: 5_000,
    outputText: null,
    error: null,
    usage: null,
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "passed", reason: "Seeded pass." },
    uiEvidence: "observed",
    navigationObserved: true,
    interactionObserved: true,
    finalUrl: `${baseURL}/shop`,
    worker: null,
    eventCount: 0,
    lastSeq: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
  };
  const runsDir = join(dataDir, "agent-runs");
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  const seeded = [
    { presetId: "catalog-cheapest-home", uiMode: "classic", evaluation: "passed", uiEvidence: "observed" },
    { presetId: "catalog-cheapest-home", uiMode: "classic", evaluation: "failed", uiEvidence: "observed" },
    { presetId: "catalog-cheapest-home", uiMode: "alternate", evaluation: "passed", uiEvidence: "observed" },
    { presetId: "catalog-cheapest-home", uiMode: "alternate", evaluation: "passed", uiEvidence: "unverified" },
    { presetId: "catalog-out-of-stock", uiMode: "classic", evaluation: "passed", uiEvidence: "observed" },
  ] as const;
  for (const [index, seed] of seeded.entries()) {
    const runId = randomUUID();
    await writeFile(
      join(runsDir, `${runId}.json`),
      `${JSON.stringify(
        {
          ...baseRecord,
          runId,
          presetId: seed.presetId,
          uiMode: seed.uiMode,
          task: `Seeded comparison run ${index + 1}.`,
          evaluation: {
            status: seed.evaluation,
            reason:
              seed.evaluation === "passed"
                ? "Seeded pass."
                : "Seeded failure.",
          },
          uiEvidence: seed.uiEvidence,
          startedAt: `2026-01-02T00:0${index}:00.000Z`,
          endedAt: `2026-01-02T00:0${index}:05.000Z`,
          updatedAt: `2026-01-02T00:0${index}:05.000Z`,
        },
        null,
        2,
      )}
`,
    );
  }

  await page.goto("/agent");
  const panel = page.getByTestId("resilience-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("resilience-live-model")).toHaveText(modelId);

  await page
    .getByTestId("resilience-task-filter")
    .selectOption("catalog-cheapest-home");
  const classicRow = panel.locator(
    '[data-testid="resilience-row"][data-preset-id="catalog-cheapest-home"][data-mode="classic"]',
  );
  const alternateRow = panel.locator(
    '[data-testid="resilience-row"][data-preset-id="catalog-cheapest-home"][data-mode="alternate"]',
  );
  await expect(classicRow.getByTestId("resilience-full-passes")).toHaveText(
    "1",
  );
  await expect(classicRow.getByTestId("resilience-sample-size")).toHaveText("2");
  await expect(alternateRow.getByTestId("resilience-full-passes")).toHaveText(
    "1",
  );
  await expect(alternateRow.getByTestId("resilience-sample-size")).toHaveText(
    "2",
  );

  await page
    .getByTestId("resilience-task-filter")
    .selectOption("catalog-out-of-stock");
  const singleRow = panel.locator(
    '[data-testid="resilience-row"][data-preset-id="catalog-out-of-stock"][data-mode="classic"]',
  );
  await expect(singleRow.getByTestId("resilience-full-passes")).toHaveText(
    "1",
  );
  await expect(singleRow).toContainText("Single run");
  await expect(singleRow).toContainText("not statistically reliable");

  await page
    .getByTestId("resilience-task-filter")
    .selectOption("catalog-cheapest-home");
  const liveButton = page.getByTestId("resilience-run-live");
  await expect(liveButton).toBeDisabled();
  await page.getByTestId("resilience-cost-confirm").check();
  await expect(liveButton).toBeEnabled();
  await liveButton.click();
  await expect(page.getByTestId("agent-task-feedback")).toContainText(
    "Preset task run started",
    { timeout: 15_000 },
  );
  await expect(liveButton).toBeDisabled();
  await expect(classicRow.getByTestId("resilience-sample-size")).toHaveText(
    "3",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("resilience-cost-confirm")).not.toBeChecked();
  await expect(liveButton).toBeDisabled();
  await page.getByTestId("resilience-cost-confirm").check();
  await expect(liveButton).toBeEnabled();
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
  await expect(page.getByTestId("agent-trace-count")).toHaveText("2", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("agent-trace-latest-action")).toContainText(
    "Tool started: javascript",
  );
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

  const statusResponse = await request.get("/api/agent/status");
  expect(statusResponse.status()).toBe(200);
  const statusBody = (await statusResponse.json()) as {
    view: { history: Array<{ runId: string; kind: string }> };
  };
  const cancelledRun = statusBody.view.history.find(
    (run) => run.kind === "task",
  );
  if (!cancelledRun) {
    throw new Error("The cancelled run was not persisted.");
  }
  const historyItem = page.locator(`[data-run-id="${cancelledRun.runId}"]`);
  await expect(historyItem).toBeVisible();
  await expect(historyItem.getByTestId("agent-history-execution")).toContainText(
    "Execution stopped (cancelled)",
  );
  await expect(historyItem.getByTestId("agent-history-result")).toHaveText(
    "Not evaluated",
  );
  await expect(historyItem.getByTestId("agent-history-error")).toBeVisible();
  await expect(historyItem).not.toContainText("Full task pass");

  const marker = JSON.parse(
    await readFile(join(dataDir, "agent-test-markers", "cancel.json"), "utf8"),
  ) as { cancelCount: number };
  expect(marker.cancelCount).toBeGreaterThan(0);
  expect(await page.content()).not.toContain(TEST_KEY);
});

test("preset catalog task passes with observed UI evidence", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  await seedKeyFile(dataDir);
  await writeCompatibilityStamp(dataDir, baseURL);

  await page.goto("/agent");
  await page
    .getByTestId("agent-preset-select")
    .selectOption("catalog-cheapest-home");
  await expect(page.getByTestId("agent-preset-instruction")).toContainText(
    "cheapest currently available product in the Home category",
  );
  await page.getByTestId("agent-run-task").click();

  await expect(page.getByTestId("agent-run-execution")).toHaveText(
    "Execution completed",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("agent-run-task-result")).toContainText(
    "Task passed",
  );
  await expect(page.getByTestId("agent-run-overall")).toHaveText(
    "Full task pass",
  );
  await expect(page.getByTestId("agent-run-preset")).toContainText("Task 1");
  await expect(page.getByTestId("agent-run-output")).toContainText(
    '"Pebble Plant Pot"',
  );
});

test("form preset passes the business evaluator and persists the record", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The E2E base URL is missing.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  await seedKeyFile(dataDir);
  await writeCompatibilityStamp(dataDir, baseURL);

  await page.goto("/agent");
  await page
    .getByTestId("agent-preset-select")
    .selectOption("form-support-request");
  await expect(page.getByTestId("agent-preset-instruction")).toContainText(
    "Using the support form, submit name Alex Demo",
  );
  await page.getByTestId("agent-run-task").click();

  await expect(page.getByTestId("agent-run-execution")).toHaveText(
    "Execution completed",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("agent-run-task-result")).toContainText(
    "Task passed",
  );
  await expect(page.getByTestId("agent-run-preset")).toContainText("Task 4");

  const outputText = await page.getByTestId("agent-run-output").textContent();
  const output = JSON.parse(outputText ?? "{}") as { requestId?: string };
  expect(output.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  await page.goto("/submissions");
  await expect(page.getByText(output.requestId ?? "")).toBeVisible();
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
      view: {
        activeRunId: string | null;
        gate: { keyAvailable: boolean; verified: boolean };
        history: Array<{ status: string }>;
      };
    };
    expect(beforeBody.view.gate.keyAvailable).toBe(true);
    expect(beforeBody.view.gate.verified).toBe(true);
    expect(beforeBody.view.activeRunId).toBeNull();
    expect(
      beforeBody.view.history.every((run) => run.status !== "running"),
    ).toBe(true);

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
            view: { history: Array<{ runId: string; status: string }> };
          };
          return (
            body.view.history.find(
              (run) => run.runId === startedBody.run.runId,
            )?.status ?? "missing"
          );
        },
        { timeout: 30_000, intervals: [100, 250, 500] },
      )
      .toBe("completed");

    await expect
      .poll(
        async () => {
          const response = await request.get("/api/agent/status");
          const body = (await response.json()) as {
            view: { activeRunId: string | null };
          };
          return body.view.activeRunId;
        },
        { timeout: 15_000, intervals: [100, 250, 500] },
      )
      .toBeNull();

    const after = await request.get("/api/agent/status");
    expect(after.status()).toBe(200);
    const afterBody = (await after.json()) as {
      view: {
        activeRunId: string | null;
        latestTask: {
          runId: string;
          status: string;
          stopReason: string | null;
          steps: number | null;
          outputText: string | null;
          evaluation: { status: string };
          uiEvidence: string;
        } | null;
      };
    };
    const run = afterBody.view.latestTask;
    expect(run).toMatchObject({
      runId: startedBody.run.runId,
      status: "completed",
      stopReason: "completed",
      steps: 3,
      outputText: '{"heading":"Shop"}',
      evaluation: { status: "not_evaluated" },
      uiEvidence: "observed",
    });
    expect(afterBody.view.activeRunId).toBeNull();
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
