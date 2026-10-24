import { expect, test } from "@playwright/test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pngBytes } from "../helpers/image-fixtures";

const dataDir = process.env.DATA_DIR;

function submissionsDir(kind: "support" | "inquiry"): string {
  if (!dataDir) throw new Error("Missing DATA_DIR for the E2E web server.");
  return join(dataDir, "submissions", kind);
}

async function submissionFiles(kind: "support" | "inquiry"): Promise<string[]> {
  try {
    return (await readdir(submissionsDir(kind))).filter((name) =>
      name.endsWith(".json"),
    );
  } catch {
    return [];
  }
}

async function clearSubmissions(): Promise<void> {
  if (!dataDir) return;
  await rm(join(dataDir, "submissions"), { recursive: true, force: true });
}

async function clearSeededFiles(): Promise<void> {
  if (!dataDir) return;
  await rm(join(dataDir, "images", "keep.png"), { force: true });
  await rm(join(dataDir, "secrets", "openrouter-key"), { force: true });
}

test.beforeEach(async () => {
  await clearSubmissions();
  await clearSeededFiles();
});

test.afterAll(async () => {
  await clearSubmissions();
  await clearSeededFiles();
});

test("the P22 detail link preselects Clarity Webcam and stores one inquiry", async ({
  page,
}) => {
  await page.goto("/shop/products/clarity-webcam");
  await page.getByRole("link", { name: "Ask about Clarity Webcam" }).click();
  await expect(page).toHaveURL(/\/forms\/inquiry\?productId=P22/);

  const product = page.getByLabel("Product");
  await expect(product).toHaveValue("P22");
  await expect(product.locator("option:checked")).toHaveText("Clarity Webcam");

  await page.getByLabel("Full name").fill("Alex Demo");
  await page.getByLabel("Email").fill("alex@example.com");
  await page.getByLabel("Inquiry type").selectOption("Specifications");
  await page
    .getByLabel("Message")
    .fill("Does this webcam support 1080p video recording?");
  await page.getByTestId("inquiry-submit").click();

  const idLabel = page.getByTestId("inquiry-request-id");
  await expect(idLabel).toBeVisible();
  const requestId = (await idLabel.textContent())?.trim() ?? "";
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const files = await submissionFiles("inquiry");
  expect(files).toEqual([`${requestId}.json`]);
  const record = JSON.parse(
    await readFile(join(submissionsDir("inquiry"), files[0] ?? ""), "utf8"),
  ) as Record<string, unknown>;
  expect(record).toMatchObject({
    id: requestId,
    productId: "P22",
    inquiryType: "Specifications",
    fullName: "Alex Demo",
    email: "alex@example.com",
    message: "Does this webcam support 1080p video recording?",
  });

  await page.reload();
  expect(await submissionFiles("inquiry")).toEqual([`${requestId}.json`]);
});

test("other product detail links also preselect their product", async ({ page }) => {
  await page.goto("/shop/products/echo-mini-speaker");
  await page.getByRole("link", { name: "Ask about Echo Mini Speaker" }).click();
  await expect(page).toHaveURL(/\/forms\/inquiry\?productId=P05/);
  await expect(page.getByLabel("Product")).toHaveValue("P05");
  await expect(
    page.getByLabel("Product").locator("option:checked"),
  ).toHaveText("Echo Mini Speaker");
});

test("an unknown product is rejected without a record", async ({ request, baseURL }) => {
  const response = await request.post("/api/forms/inquiry", {
    headers: { origin: baseURL ?? "" },
    data: {
      requestId: "88888888-8888-4888-8888-888888888888",
      fullName: "Alex Demo",
      email: "alex@example.com",
      productId: "P99",
      inquiryType: "Specifications",
      message: "Does this webcam support 1080p video recording?",
    },
  });
  expect(response.status()).toBe(422);
  expect(await submissionFiles("inquiry")).toEqual([]);
});

test("the submissions view lists both forms and reset keeps images and keys", async ({
  page,
  request,
  baseURL,
}) => {
  if (!dataDir) throw new Error("Missing DATA_DIR for the E2E web server.");
  const origin = baseURL ?? "";
  const support = await request.post("/api/forms/support", {
    headers: { origin },
    data: {
      requestId: "99999999-9999-4999-8999-999999999999",
      fullName: "Alex Demo",
      email: "alex@example.com",
      subject: "Payment confirmation issue",
      priority: "High",
      description: "I did not receive a confirmation after the simulated payment.",
      confirmLocalTest: true,
    },
  });
  expect(support.status()).toBe(201);
  const inquiry = await request.post("/api/forms/inquiry", {
    headers: { origin },
    data: {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fullName: "Alex Demo",
      email: "alex@example.com",
      productId: "P22",
      inquiryType: "Specifications",
      message: "Does this webcam support 1080p video recording?",
    },
  });
  expect(inquiry.status()).toBe(201);

  await mkdir(join(dataDir, "images"), { recursive: true });
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "images", "keep.png"), pngBytes(32, 32));
  await writeFile(join(dataDir, "secrets", "openrouter-key"), "sk-or-v1-keep");

  await page.goto("/submissions");
  await expect(page.getByRole("heading", { level: 1, name: "Submissions" })).toBeVisible();
  await expect(page.getByText("Support (1)")).toBeVisible();
  await expect(page.getByText("Inquiry (1)")).toBeVisible();
  await expect(page.getByText(/P22 · Specifications:/)).toBeVisible();

  const reset = page.getByTestId("reset-submissions");
  await expect(reset).toBeDisabled();
  await page.getByTestId("reset-confirm").check();
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(page.getByRole("status")).toContainText("Removed 1 support and 1 inquiry");

  await page.reload();
  await expect(page.getByText("Support (0)")).toBeVisible();
  await expect(page.getByText("Inquiry (0)")).toBeVisible();
  expect(await submissionFiles("support")).toEqual([]);
  expect(await submissionFiles("inquiry")).toEqual([]);
  expect((await stat(join(dataDir, "images", "keep.png"))).isFile()).toBe(true);
  expect((await stat(join(dataDir, "secrets", "openrouter-key"))).isFile()).toBe(true);
});
