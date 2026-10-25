import { expect, test, type APIRequestContext } from "@playwright/test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.env.DATA_DIR;
const origin = `http://127.0.0.1:${process.env.E2E_PORT ?? "4310"}`;

async function setUiMode(
  request: APIRequestContext,
  mode: "classic" | "alternate",
): Promise<void> {
  const response = await request.post("/api/ui/mode", {
    headers: { origin },
    data: { mode },
  });
  expect(response.status()).toBe(200);
}

async function resetUiMode(): Promise<void> {
  const response = await fetch(`${origin}/api/ui/mode`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ mode: "classic" }),
  });
  expect(response.status).toBe(200);
}

async function clearSubmissions(): Promise<void> {
  if (!dataDir) return;
  await rm(join(dataDir, "submissions"), { recursive: true, force: true });
}

test.beforeEach(async () => {
  await clearSubmissions();
});

test.afterAll(async () => {
  await clearSubmissions();
  await resetUiMode();
});

test("Alternate rearranges the catalog and forms without changing data or routes", async ({
  page,
  request,
}) => {
  await setUiMode(request, "classic");
  await page.goto("/shop");
  await expect(page.getByTestId("ui-mode-switcher")).toHaveAttribute(
    "data-ui-mode",
    "classic",
  );
  await expect(page.getByTestId("catalog-layout")).toHaveAttribute(
    "data-ui-mode",
    "classic",
  );

  await page.getByTestId("ui-mode-alternate").click();
  await expect(page.getByTestId("ui-mode-switcher")).toHaveAttribute(
    "data-ui-mode",
    "alternate",
  );
  await expect(page).toHaveURL(/\/shop$/);
  await expect(page.getByTestId("catalog-layout")).toHaveAttribute(
    "data-ui-mode",
    "alternate",
  );
  await expect(page.locator('[data-product-id="P01"]')).toBeVisible();
  await expect(page.getByRole("search", { name: "Catalog filters" })).toHaveAttribute(
    "data-ui-mode",
    "alternate",
  );

  await page.getByLabel("Search products").fill("headphones");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/[?&]q=headphones(?:&|$)/);
  await expect(page.locator("[data-product-id]")).toHaveCount(2);
  await expect(page.locator('[data-product-id="P01"]')).toBeVisible();
  await expect(page.locator('[data-product-id="P13"]')).toBeVisible();

  await page.goto("/forms/support");
  await expect(page.getByTestId("support-form")).toHaveAttribute(
    "data-ui-mode",
    "alternate",
  );
  await page.getByLabel("Full name").fill("Alternate Demo");
  await page.getByLabel("Email").fill("alternate@example.com");
  await page.getByLabel("Subject").fill("Alternate layout test");
  await page.getByLabel("Priority").selectOption("Normal");
  await page.getByLabel("Description").fill("The alternate form layout keeps the data.");
  await page.getByTestId("support-review").click();
  await expect(page.getByRole("heading", { name: "Review your request" })).toBeVisible();
  await page.getByTestId("support-confirm-local-test").check();
  await page.getByTestId("support-submit").click();
  await expect(page.getByTestId("support-request-id")).toBeVisible();

  await page.goto("/forms/inquiry?productId=P22");
  await expect(page.getByTestId("inquiry-form")).toHaveAttribute(
    "data-ui-mode",
    "alternate",
  );
  await page.getByLabel("Full name").fill("Alternate Demo");
  await page.getByLabel("Email").fill("alternate@example.com");
  await expect(page.getByLabel("Product")).toHaveValue("P22");
  await page.getByLabel("Inquiry type").selectOption("Specifications");
  await page.getByLabel("Message").fill("Does the alternate layout keep this value?");
  await page.getByTestId("inquiry-submit").click();
  await expect(page.getByTestId("inquiry-request-id")).toBeVisible();

  await page.goto("/agent");
  await expect(page.getByTestId("ui-mode-switcher")).toHaveAttribute(
    "data-ui-mode",
    "alternate",
  );

  await page.goto("/shop");
  await page.getByTestId("ui-mode-classic").click();
  await expect(page.getByTestId("catalog-layout")).toHaveAttribute(
    "data-ui-mode",
    "classic",
  );
  await expect(page).toHaveURL(/\/shop$/);
});
