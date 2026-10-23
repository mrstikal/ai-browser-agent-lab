import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pngBytes } from "../helpers/image-fixtures";

const dataDir = process.env.DATA_DIR;

function attemptId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function seedImages(count: number): Promise<void> {
  if (!dataDir) throw new Error("Missing DATA_DIR for the E2E web server.");
  const imagesDir = join(dataDir, "images");
  await mkdir(imagesDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const bytes = pngBytes(32, 32);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const products: Record<string, unknown> = {};

  for (let index = 1; index <= 24; index += 1) {
    const productId = `P${String(index).padStart(2, "0")}`;
    if (index > count) {
      products[productId] = { active: null, attempts: [] };
      continue;
    }
    const id = attemptId(1100 + index);
    const filename = `${productId}-${id}.png`;
    await writeFile(join(imagesDir, filename), bytes);
    products[productId] = {
      active: {
        attemptId: id,
        filename,
        format: "png",
        mediaType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256,
        width: 32,
        height: 32,
        publishedAt: timestamp,
      },
      attempts: [
        {
          attemptId: id,
          startedAt: timestamp,
          finishedAt: timestamp,
          status: "succeeded",
          filename,
          format: "png",
          mediaType: "image/png",
          sizeBytes: bytes.byteLength,
          sha256,
          width: 32,
          height: 32,
          cost: { kind: "reported", usd: 0.008 },
          error: null,
        },
      ],
    };
  }

  await writeFile(
    join(imagesDir, "manifest.json"),
    `${JSON.stringify({ version: 1, updatedAt: timestamp, products }, null, 2)}\n`,
  );
}

async function seedJob(options: {
  readonly status:
    | "running"
    | "stopping"
    | "completed"
    | "failed"
    | "interrupted"
    | "stopped_by_user";
  readonly targets: Array<{
    readonly productId: string;
    readonly status: "queued" | "succeeded" | "failed";
    readonly attemptId?: string | null;
    readonly error?: string | null;
  }>;
}): Promise<string> {
  if (!dataDir) throw new Error("Missing DATA_DIR for the E2E web server.");
  const jobId = attemptId(1200);
  const timestamp = new Date().toISOString();
  const needsStop = options.status === "stopping" || options.status === "stopped_by_user";
  await writeFile(
    join(dataDir, "image-job.json"),
    `${JSON.stringify(
      {
        version: 1,
        jobId,
        status: options.status,
        createdAt: timestamp,
        updatedAt: timestamp,
        targets: options.targets.map((target) => ({
          productId: target.productId,
          status: target.status,
          attemptId: target.attemptId ?? null,
          error: target.error ?? null,
        })),
        stopRequest: needsStop ? { jobId, requestedAt: timestamp } : null,
        quote: null,
        error: null,
      },
      null,
      2,
    )}\n`,
  );
  return jobId;
}

async function imageFileCount(): Promise<number> {
  if (!dataDir) return 0;
  try {
    return (await readdir(join(dataDir, "images"))).filter((name) =>
      name.endsWith(".png"),
    ).length;
  } catch {
    return 0;
  }
}

test.beforeEach(async () => {
  if (!dataDir) return;
  await rm(join(dataDir, "images"), { recursive: true, force: true });
  await rm(join(dataDir, "image-job.json"), { force: true });
});

test.afterAll(async () => {
  if (!dataDir) return;
  await rm(join(dataDir, "images"), { recursive: true, force: true });
  await rm(join(dataDir, "image-job.json"), { force: true });
});

test("two tabs and a refresh share the zero-job state", async ({ page, context }) => {
  await page.goto("/setup");
  await expect(page.getByTestId("job-status")).toContainText("No batch started");
  await expect(page.getByTestId("progress-counts")).toContainText("0 of 24");

  const secondPage = await context.newPage();
  await secondPage.goto("/setup");
  await expect(secondPage.getByTestId("job-status")).toContainText("No batch started");

  await page.reload();
  await expect(page.getByTestId("job-status")).toContainText("No batch started");
  await secondPage.reload();
  await expect(secondPage.getByTestId("job-status")).toContainText("No batch started");
  await secondPage.close();
});

test("two tabs and a refresh share running then stopping state; Stop sends no new requests", async ({
  page,
  context,
  request,
}) => {
  await seedImages(3);
  const jobId = await seedJob({
    status: "running",
    targets: [{ productId: "P04", status: "queued" }],
  });
  const connectionsBefore = await imageFileCount();

  await page.goto("/setup");
  await expect(page.getByTestId("progress-panel")).toBeVisible();
  await expect(page.getByTestId("job-status")).toContainText("Generating");
  await expect(page.getByTestId("progress-counts")).toContainText("3 of 24");
  await expect(page.getByTestId("stop-batch")).toBeVisible();
  await expect(page.getByTestId("progress-connection")).toContainText("Live updates");

  const secondPage = await context.newPage();
  await secondPage.goto("/setup");
  await expect(secondPage.getByTestId("job-status")).toContainText("Generating");

  await page.getByTestId("stop-batch").click();
  await expect(page.getByTestId("job-status")).toContainText("Stopping");
  await expect(secondPage.getByTestId("job-status")).toContainText("Stopping");

  const snapshot = (await (await request.get("/api/images/progress")).json()) as {
    job: { jobId: string; status: string; stopRequested: boolean };
  };
  expect(snapshot.job).toMatchObject({
    jobId,
    status: "stopping",
    stopRequested: true,
  });

  await page.reload();
  await expect(page.getByTestId("job-status")).toContainText("Stopping");
  expect(await imageFileCount()).toBe(connectionsBefore);
  await secondPage.close();
});

test("a failed job shows failures and retry/resume confirmations", async ({ page }) => {
  await seedImages(23);
  await seedJob({
    status: "failed",
    targets: [
      {
        productId: "P24",
        status: "failed",
        attemptId: attemptId(1300),
        error: "provider error",
      },
    ],
  });

  await page.goto("/setup");
  await expect(page.getByTestId("job-status")).toContainText("Failed");
  await expect(page.getByText("P24 — provider error")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry failed (1)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume missing (1)" })).toBeVisible();
});

test("stopped-by-user and completed states render distinctly", async ({ page }) => {
  await seedImages(23);
  await seedJob({
    status: "stopped_by_user",
    targets: [
      {
        productId: "P24",
        status: "failed",
        attemptId: attemptId(1301),
        error: "stopped before response settled",
      },
    ],
  });

  await page.goto("/setup");
  await expect(page.getByTestId("job-status")).toContainText("Stopped by user");
  await expect(page.getByRole("button", { name: "Retry failed (1)" })).toBeVisible();
  await expect(page.getByTestId("stop-batch")).toHaveCount(0);

  await seedImages(24);
  await seedJob({
    status: "completed",
    targets: [
      {
        productId: "P24",
        status: "succeeded",
        attemptId: attemptId(1302),
      },
    ],
  });

  await page.goto("/setup");
  await expect(page.getByTestId("job-status")).toContainText("Completed");
  await expect(page.getByTestId("progress-counts")).toContainText("24 of 24");
  await expect(page.getByTestId("stop-batch")).toHaveCount(0);
});