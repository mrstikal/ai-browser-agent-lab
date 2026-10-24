import { expect, test } from "@playwright/test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.env.DATA_DIR;

function submissionsDir(): string {
  if (!dataDir) throw new Error("Missing DATA_DIR for the E2E web server.");
  return join(dataDir, "submissions", "support");
}

async function submissionFiles(): Promise<string[]> {
  try {
    return (await readdir(submissionsDir())).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

async function clearSubmissions(): Promise<void> {
  if (!dataDir) return;
  await rm(join(dataDir, "submissions", "support"), {
    recursive: true,
    force: true,
  });
}

test.beforeEach(async () => {
  await clearSubmissions();
  await mkdir(submissionsDir(), { recursive: true });
});

test.afterAll(clearSubmissions);

test("Review creates no record, invalid email blocks, and a confirmed submit creates exactly one", async ({
  page,
}) => {
  await page.goto("/forms/support");
  await expect(
    page.getByRole("heading", { level: 1, name: "Support request" }),
  ).toBeVisible();

  await page.getByLabel("Full name").fill("Alex Demo");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Subject").fill("Payment confirmation issue");
  await page.getByLabel("Priority").selectOption("High");
  await page
    .getByLabel("Description")
    .fill("I did not receive a confirmation after the simulated payment.");
  await page.getByTestId("support-review").click();

  await expect(page.locator("#support-email-error")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review your request" })).toHaveCount(0);
  expect(await submissionFiles()).toEqual([]);

  await page.getByLabel("Email").fill("alex@example.com");
  await page.getByTestId("support-review").click();

  const review = page.getByRole("heading", { name: "Review your request" });
  await expect(review).toBeVisible();
  await expect(page.getByText("Alex Demo")).toBeVisible();
  await expect(page.getByText("alex@example.com")).toBeVisible();
  await expect(page.getByText("Payment confirmation issue")).toBeVisible();
  await expect(page.getByText("High", { exact: true })).toBeVisible();
  expect(await submissionFiles()).toEqual([]);

  const submit = page.getByTestId("support-submit");
  await expect(submit).toBeDisabled();
  expect(await submissionFiles()).toEqual([]);

  await page.getByTestId("support-confirm-local-test").check();
  await expect(submit).toBeEnabled();
  await submit.click();

  const requestIdLabel = page.getByTestId("support-request-id");
  await expect(requestIdLabel).toBeVisible();
  const requestId = (await requestIdLabel.textContent())?.trim() ?? "";
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const files = await submissionFiles();
  expect(files).toEqual([`${requestId}.json`]);
  const record = JSON.parse(
    await readFile(join(submissionsDir(), files[0] ?? ""), "utf8"),
  ) as Record<string, unknown>;
  expect(record).toMatchObject({
    id: requestId,
    fullName: "Alex Demo",
    email: "alex@example.com",
    subject: "Payment confirmation issue",
    priority: "High",
    confirmLocalTest: true,
  });

  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Support request" }),
  ).toBeVisible();
  expect(await submissionFiles()).toEqual([`${requestId}.json`]);
});