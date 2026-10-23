import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pngBytes } from "../helpers/image-fixtures";

test.describe.configure({ mode: "serial" });

const dataDir = process.env.DATA_DIR;

test.beforeEach(async () => {
  if (!dataDir) return;
  await rm(join(dataDir, "images"), { recursive: true, force: true });
});

function attemptId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function imageManifest(count: number): string {
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
    const id = attemptId(200 + index);
    const filename = `${productId}-${id}.png`;
    const attempt = {
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
      cost: { kind: "unknown" },
      error: null,
    };
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
      attempts: [attempt],
    };
  }

  return `${JSON.stringify({ version: 1, updatedAt: timestamp, products }, null, 2)}\n`;
}

async function seedImages(count: number): Promise<void> {
  if (!dataDir) throw new Error("Missing DATA_DIR for the E2E web server.");
  const imagesDir = join(dataDir, "images");
  await mkdir(imagesDir, { recursive: true });
  const bytes = pngBytes(32, 32);
  for (let index = 1; index <= count; index += 1) {
    const productId = `P${String(index).padStart(2, "0")}`;
    const id = attemptId(200 + index);
    await writeFile(join(imagesDir, `${productId}-${id}.png`), bytes);
  }
  await writeFile(join(imagesDir, "manifest.json"), imageManifest(count));
}

test("fresh visitors are guided into the setup wizard and state survives a refresh", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
  await expect(page.getByTestId("setup-status")).toContainText("API key needed");
  await expect(page.getByTestId("key-status")).toContainText("No key available");
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "key-required",
  );
  await expect(page.locator("#openrouter-key")).toHaveAttribute("type", "password");
  await expect(page.locator('input[name="remember"]')).not.toBeChecked();
  await expect(page.locator("#browser-model-id")).toHaveValue(
    "openrouter/openai/gpt-5.6-luna",
  );

  await page.reload();
  await expect(page.getByTestId("setup-status")).toContainText("API key needed");
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "key-required",
  );
});

test("malformed keys fail visibly without contacting the provider", async ({ page }) => {
  await page.goto("/setup");
  await page.locator("#openrouter-key").fill("short key");
  await page.getByRole("button", { name: "Validate and save key" }).click();
  await expect(page.getByText("format is not acceptable")).toBeVisible();
  await expect(page.getByTestId("key-status")).toContainText("No key available");
});

test("browser model choices validate and persist independently", async ({ page }) => {
  await page.goto("/setup");
  const form = page.getByTestId("browser-model-form");
  await page.locator("#browser-model-id").fill("no-slash");
  await form.getByRole("button", { name: "Save browser model" }).click();
  await expect(form.getByRole("alert")).toContainText(
    "does not match the expected schema",
  );

  await page.locator("#browser-model-id").fill("openrouter/openai/advanced:free-1");
  await form.getByRole("button", { name: "Save browser model" }).click();
  await expect(form.getByRole("status")).toContainText("saved");
  await page.reload();
  await expect(page.locator("#browser-model-id")).toHaveValue(
    "openrouter/openai/advanced:free-1",
  );
  await expect(page.locator("#image-model-id")).toHaveValue(
    "black-forest-labs/flux-3-image-klein",
  );
});

test("partial images render as incomplete while the shop stays browsable", async ({
  page,
}) => {
  await seedImages(3);
  await page.goto("/setup");
  await expect(page.getByTestId("image-progress")).toContainText("3 of 24");
  await expect(page.getByTestId("setup-status")).toContainText("incomplete");
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "key-required",
  );

  await page.goto("/shop");
  await expect(page.getByRole("heading", { level: 1, name: "Shop" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Orbit Wireless Headphones/ })).toBeVisible();
});

test("a corrupt manifest disables the quote panel instead of claiming completion", async ({
  page,
}) => {
  if (!dataDir) throw new Error("Missing DATA_DIR for the E2E web server.");
  const imagesDir = join(dataDir, "images");
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, "manifest.json"), "{not json");

  await page.goto("/setup");
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "image-state-unreadable",
  );
  await expect(page.getByTestId("quote-state")).toContainText(
    "Saved image state is unreadable",
  );
});

test("completed images without a key render correctly", async ({ page }) => {
  await seedImages(24);
  await page.goto("/setup");
  await expect(page.getByTestId("image-progress")).toContainText("24 of 24");
  await expect(page.getByTestId("setup-status")).toContainText(
    "All 24 images are ready",
  );
  await expect(page.getByTestId("quote-state")).toHaveAttribute(
    "data-code",
    "completed",
  );
  await expect(page.getByTestId("key-status")).toContainText("No key available");
  await expect(page.locator("#openrouter-key")).toBeVisible();

  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "AI Browser Agent Lab",
  );
});
