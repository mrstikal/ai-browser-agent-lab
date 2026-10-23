import { expect, test, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

test.beforeEach(async () => {
  const dataDir = process.env.DATA_DIR;
  if (dataDir) {
    await rm(join(dataDir, "images"), { recursive: true, force: true });
  }
});

const defaultPages = [
  ["P01", "P02", "P03", "P04", "P05", "P06"],
  ["P07", "P08", "P09", "P10", "P11", "P12"],
  ["P13", "P14", "P15", "P16", "P17", "P18"],
  ["P19", "P20", "P21", "P22", "P23", "P24"],
] as const;

async function productIds(page: Page): Promise<string[]> {
  return page.locator("[data-product-id]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-product-id") ?? ""),
  );
}

async function expectIds(page: Page, ids: readonly string[]): Promise<void> {
  await expect(page.locator("[data-product-id]")).toHaveCount(ids.length);
  expect(await productIds(page)).toEqual(ids);
}

test("renders all four default pages with working pagination", async ({ page }) => {
  await page.goto("/shop");
  await expect(page.getByRole("heading", { level: 1, name: "Shop" })).toBeVisible();
  await expect(page.getByText("Showing 1–6 of 24 products.", { exact: true })).toBeVisible();
  await expect(page.getByText("Page 1 of 4", { exact: true })).toBeVisible();
  await expectIds(page, defaultPages[0]);
  await expect(page.getByText("Previous", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  const pagination = page.getByRole("navigation", { name: "Pagination" });
  await expect(pagination.locator('[aria-current="page"]')).toHaveText("1");

  await pagination.getByRole("link", { name: "Page 2" }).click();
  await expect(page).toHaveURL(/\/shop\?page=2$/);
  await expectIds(page, defaultPages[1]);
  await expect(page.getByText("Showing 7–12 of 24 products.", { exact: true })).toBeVisible();
  await expect(page.getByText("Page 2 of 4", { exact: true })).toBeVisible();

  await page.goto("/shop?page=3");
  await expectIds(page, defaultPages[2]);
  await expect(page.getByText("Showing 13–18 of 24 products.", { exact: true })).toBeVisible();

  await page.goto("/shop?page=4");
  await expectIds(page, defaultPages[3]);
  await expect(page.getByText("Showing 19–24 of 24 products.", { exact: true })).toBeVisible();
  await expect(page.getByText("Next", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByRole("link", { name: "Next" })).toHaveCount(0);

  await page.getByRole("link", { name: "Previous" }).click();
  await expect(page).toHaveURL(/\/shop\?page=3$/);
  await expectIds(page, defaultPages[2]);
});

test("shows USD prices, stock labels, and useful placeholder text", async ({ page }) => {
  await page.goto("/shop");
  const p01 = page.locator('[data-product-id="P01"]');
  await expect(p01.getByText("Audio", { exact: true })).toBeVisible();
  await expect(p01.getByText("$89.00", { exact: true })).toBeVisible();
  await expect(p01.getByText("In stock", { exact: true })).toBeVisible();
  await expect(
    p01.getByRole("img", { name: "Placeholder image for Orbit Wireless Headphones" }),
  ).toBeVisible();
  await expect(
    p01.getByRole("link", { name: "Orbit Wireless Headphones" }),
  ).toHaveAttribute("href", "/shop/products/orbit-wireless-headphones");

  const p04 = page.locator('[data-product-id="P04"]');
  await expect(p04.getByText("$79.00", { exact: true })).toBeVisible();
  await expect(p04.getByText("Out of stock", { exact: true })).toBeVisible();
  await expect(
    p04.getByRole("img", { name: "Placeholder image for Atlas Travel Backpack" }),
  ).toBeVisible();
});

test("filters by trimmed, case-insensitive name search and handles zero results", async ({
  page,
}) => {
  await page.goto("/shop?q=%20HEADPHONES%20");
  await expectIds(page, ["P01", "P13"]);
  await expect(page.getByText("Showing 1–2 of 2 products.", { exact: true })).toBeVisible();

  await page.goto("/shop?q=lamp");
  await expectIds(page, ["P03"]);
  await expect(page.getByText("Showing 1 product.", { exact: true })).toBeVisible();

  await page.goto("/shop?q=zzz");
  await expectIds(page, []);
  await expect(page.getByText("0 products.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "No products found" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pagination" })).toHaveCount(0);
});

test("combines category, stock, and price sorting and preserves options in page links", async ({
  page,
}) => {
  await page.goto("/shop?category=Audio&stock=in&sort=price-asc");
  await expectIds(page, ["P21", "P05", "P01", "P13", "P17"]);
  await expect(page.getByText("Showing 1–5 of 5 products.", { exact: true })).toBeVisible();

  await page.goto("/shop?stock=in&sort=price-asc");
  const pagination = page.getByRole("navigation", { name: "Pagination" });
  await expect(pagination.getByRole("link", { name: "Page 2" })).toHaveAttribute(
    "href",
    "/shop?stock=in&sort=price-asc&page=2",
  );
  await pagination.getByRole("link", { name: "Page 2" }).click();
  await expect(page).toHaveURL(/\/shop\?stock=in&sort=price-asc&page=2$/);
  await expectIds(page, ["P06", "P11", "P21", "P10", "P03", "P05"]);

  await page.goto("/shop?sort=price-desc&page=2");
  await expectIds(page, ["P22", "P04", "P23", "P09", "P18", "P05"]);
});

test("uses accessible GET controls and resets to page 1 on search", async ({ page }) => {
  await page.goto("/shop?page=3");
  await expect(page.getByText("Page 3 of 4", { exact: true })).toBeVisible();
  await expect(page.getByRole("search", { name: "Catalog filters" })).toBeVisible();

  await page.getByLabel("Search products").fill("headphones");
  await page.getByLabel("Category").selectOption("Audio");
  await page.getByLabel("In stock only").check();
  await page.getByLabel("Sort").selectOption("price-asc");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).not.toHaveURL(/[?&]page=/);
  await expect(page).toHaveURL(/[?&]q=headphones/);
  await expect(page).toHaveURL(/[?&]category=Audio/);
  await expect(page).toHaveURL(/[?&]stock=in/);
  await expect(page).toHaveURL(/[?&]sort=price-asc/);
  await expectIds(page, ["P01", "P13"]);
  await expect(page.getByText("Showing 1–2 of 2 products.", { exact: true })).toBeVisible();
});

test("normalizes invalid controls and clamps page overflow", async ({ page }) => {
  await page.goto("/shop?stock=out&category=audio&sort=price&page=99");
  await expectIds(page, defaultPages[3]);
  await expect(page.getByText("Showing 19–24 of 24 products.", { exact: true })).toBeVisible();
  await expect(page.getByText("Page 4 of 4", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Category")).toHaveValue("");
  await expect(page.getByLabel("Sort")).toHaveValue("default");
  await expect(page.getByLabel("In stock only")).not.toBeChecked();
});

test.describe("catalog without client JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("renders, paginates, and filters with native GET controls", async ({ page }) => {
    await page.goto("/shop");
    await expect(page.getByRole("heading", { level: 1, name: "Shop" })).toBeVisible();
    await expectIds(page, defaultPages[0]);

    await page.getByRole("navigation", { name: "Pagination" })
      .getByRole("link", { name: "Page 2" })
      .click();
    await expect(page).toHaveURL(/\/shop\?page=2$/);
    await expectIds(page, defaultPages[1]);

    await page.getByLabel("Search products").fill("lamp");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/[?&]q=lamp/);
    await expectIds(page, ["P03"]);
    await expect(page.getByText("Showing 1 product.", { exact: true })).toBeVisible();
  });
});
