import { expect, test } from "@playwright/test";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Full first-run image flow against the loopback mock OpenRouter started by
 * scripts/run-e2e.mjs. The mock accepts exactly one dummy key, so this proves
 * that E2E never needs or forwards a real credential and that all provider
 * traffic stays on the loopback origin.
 */

const dataDir = process.env.DATA_DIR;
const dummyKey = process.env.MOCK_OPENROUTER_KEY;
const statsUrl = process.env.MOCK_OPENROUTER_STATS_URL;
const resetUrl = process.env.MOCK_OPENROUTER_RESET_URL;

test.describe.configure({ mode: "serial" });

function requireEnv(): { dataDir: string; dummyKey: string; statsUrl: string; resetUrl: string } {
  if (!dataDir) throw new Error("The E2E DATA_DIR is missing.");
  if (!dummyKey) throw new Error("MOCK_OPENROUTER_KEY is missing.");
  if (!statsUrl) throw new Error("MOCK_OPENROUTER_STATS_URL is missing.");
  if (!resetUrl) throw new Error("MOCK_OPENROUTER_RESET_URL is missing.");
  return { dataDir, dummyKey, statsUrl, resetUrl };
}

async function clearImages(): Promise<void> {
  if (!dataDir) return;
  await rm(join(dataDir, "images"), { recursive: true, force: true });
  await rm(join(dataDir, "image-job.json"), { force: true });
}

async function walkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function filesContaining(
  directory: string,
  needle: string,
  ignorePath: string,
): Promise<string[]> {
  const needleBytes = Buffer.from(needle);
  const matches: string[] = [];
  for (const file of await walkFiles(directory)) {
    if (file === ignorePath) continue;
    const bytes = await readFile(file);
    if (bytes.includes(needleBytes)) matches.push(file);
  }
  return matches;
}

test.beforeAll(clearImages);

test.afterAll(async ({ request, baseURL }) => {
  try {
    await request.delete("/api/setup/key", {
      data: {},
      headers: baseURL ? { origin: baseURL } : {},
    });
  } catch {
    // Best effort; the isolated data directory is removed by run-e2e.
  }
  await clearImages();
});

test("the loopback mock rejects a non-dummy key without storing it", async ({
  page,
  request,
}) => {
  const env = requireEnv();
  await request.post(env.resetUrl);
  // Warm the dev route so the first browser navigation does not race the
  // initial Turbopack compile (which can emit an HMR hash-mismatch reload).
  expect((await request.get("/setup")).status()).toBe(200);
  await page.goto("/setup");
  await expect(page.getByTestId("progress-connection")).toContainText("Live updates");
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "key-required",
  );

  await page.locator("#openrouter-key").fill(`sk-or-v1-${"0".repeat(64)}`);
  await page.getByRole("button", { name: "Validate and save key" }).click();
  await expect(page.getByText("OpenRouter rejected this key")).toBeVisible();
  await expect(page.getByTestId("key-status")).toContainText("No key available");

  const stats = (await (await request.get(env.statsUrl)).json()) as {
    unauthorizedRequests: number;
    foreignAuthorization: number;
    imageRequests: number;
  };
  expect(stats.foreignAuthorization).toBeGreaterThan(0);
  expect(stats.unauthorizedRequests).toBeGreaterThan(0);
  expect(stats.imageRequests).toBe(0);
});

test("a confirmed 24-image batch runs against the mock and persists no key outside the secret file", async ({
  page,
  request,
}) => {
  const env = requireEnv();
  await request.post(env.resetUrl);

  await page.goto("/setup");
  await expect(page.getByTestId("progress-connection")).toContainText("Live updates");
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "key-required",
  );

  await page.locator("#openrouter-key").fill(env.dummyKey);
  await page.locator('input[name="remember"]').check();
  await page.getByRole("button", { name: "Validate and save key" }).click();
  await expect(page.getByTestId("key-status")).toContainText(
    "Key available (Remember on",
  );

  await expect(page.getByTestId("quote-state")).toHaveAttribute("data-code", "ok");
  await expect(page.getByTestId("quote-state")).toContainText(
    "24 target image(s) at 0.008 USD each from provider mock-provider",
  );
  await expect(page.getByTestId("quote-state")).toContainText(
    "base 0.192 USD, worst case 0.576 USD",
  );

  await expect(page.getByTestId("progress-connection")).toContainText("Live updates");
  await page
    .locator('[data-testid="confirm-estimate-form"] input[type="checkbox"]')
    .check();
  await page.getByRole("button", { name: "Confirm and start batch" }).click();

  await expect(page.getByTestId("progress-counts")).toHaveText("24 of 24", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("job-status")).toHaveText("Completed", {
    timeout: 60_000,
  });

  await page.goto("/setup");
  await expect(page.getByTestId("setup-status")).toContainText(
    "All 24 images are ready",
  );
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "completed",
  );

  await page.goto("/shop");
  const firstImage = page.getByRole("img", { name: "Orbit Wireless Headphones" });
  await expect(firstImage).toBeVisible();
  await expect(firstImage).toHaveAttribute("src", /\/api\/images\/P01\?v=/);

  const stats = (await (await request.get(env.statsUrl)).json()) as {
    imageRequests: number;
    unauthorizedRequests: number;
    foreignAuthorization: number;
    invalidImageRequests: number;
    lastImageRequest: {
      model: string;
      n: number;
      resolution: string;
      aspectRatio: string;
      outputFormat: string;
      providerOnly: string[];
    } | null;
  };
  expect(stats.imageRequests).toBe(24);
  expect(stats.unauthorizedRequests).toBe(0);
  expect(stats.foreignAuthorization).toBe(0);
  expect(stats.invalidImageRequests).toBe(0);
  expect(stats.lastImageRequest).toMatchObject({
    model: "black-forest-labs/flux-3-image-klein",
    n: 1,
    resolution: "768",
    aspectRatio: "1:1",
    outputFormat: "png",
    providerOnly: ["mock-provider"],
  });

  const keyPath = join(env.dataDir, "secrets", "openrouter-key");
  expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  expect((await readFile(keyPath, "utf8")).trim()).toBe(env.dummyKey);
  expect(await filesContaining(env.dataDir, env.dummyKey, keyPath)).toEqual([]);

  await page.goto("/setup");
  await expect(page.getByTestId("progress-connection")).toContainText("Live updates");
  await page.getByRole("button", { name: "Delete key" }).click();
  await expect(page.getByTestId("key-status")).toContainText("No key available");
});
