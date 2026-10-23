import { expect, test } from "@playwright/test";
import { products } from "../../src/lib/products";

test.describe("product detail URLs", () => {
  for (const product of products) {
    test(`${product.id} ${product.name}`, async ({ page }) => {
      const response = await page.goto(`/shop/products/${product.slug}`);
      expect(response?.status()).toBe(200);

      await expect(page.locator(`[data-product-id="${product.id}"]`)).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 1, name: product.name }),
      ).toBeVisible();
      await expect(page).toHaveTitle(`${product.name} | AI Browser Agent Lab`);
      await expect(page.getByText(product.description, { exact: true })).toBeVisible();
      await expect(
        page.getByText(`$${product.priceUsd.toFixed(2)}`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(
          product.stock > 0 ? `In stock (${product.stock} available)` : "Out of stock",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("img", { name: `Placeholder image for ${product.name}` }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: `Ask about ${product.name}` }),
      ).toHaveAttribute("href", `/forms/inquiry?productId=${product.id}`);
      await expect(page.getByRole("link", { name: "Back to shop" })).toBeVisible();
    });
  }
});

test("returns a real 404 for unknown product slugs", async ({ page }) => {
  for (const slug of ["does-not-exist", "Pebble-Plant-Pot", "pebble-plant-pot-extra"]) {
    const response = await page.goto(`/shop/products/${slug}`);
    expect(response?.status()).toBe(404);
    await expect(page.locator("[data-product-id]")).toHaveCount(0);
  }
});

test("links from a catalog card through the detail page to the inquiry form", async ({
  page,
}) => {
  await page.goto("/shop?page=4");
  await page.getByRole("link", { name: "Clarity Webcam" }).click();
  await expect(page).toHaveURL(/\/shop\/products\/clarity-webcam$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Clarity Webcam" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Ask about Clarity Webcam" }).click();
  await expect(page).toHaveURL(/\/forms\/inquiry\?productId=P22$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Product inquiry" }),
  ).toBeVisible();
});
