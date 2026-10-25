import type { Metadata } from "next";
import { CatalogFilters } from "@/components/catalog-filters";
import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductCard } from "@/components/product-card";
import { UiModeSwitcher } from "@/components/ui-mode-switcher";
import {
  CATALOG_PAGE_SIZE,
  parseCatalogQuery,
  selectCatalogPage,
} from "@/lib/catalog";
import { products } from "@/lib/products";
import { loadDeliverableImages } from "@/server/image-delivery";
import { createStorage } from "@/server/storage";
import { loadUiModeView } from "@/server/ui-mode";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shop",
};

interface ShopPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ShopPage({ searchParams }: ShopPageProps) {
  const query = parseCatalogQuery(await searchParams);
  const result = selectCatalogPage(products, query);
  const storage = createStorage();
  const uiMode = await loadUiModeView(storage);
  const deliverable = await loadDeliverableImages(storage);
  const start =
    result.total === 0 ? 0 : (result.page - 1) * CATALOG_PAGE_SIZE + 1;
  const end =
    result.total === 0
      ? 0
      : Math.min(result.page * CATALOG_PAGE_SIZE, result.total);
  const countLabel =
    result.total === 0
      ? "0 products."
      : result.total === 1
        ? "Showing 1 product."
        : `Showing ${start}–${end} of ${result.total} products.`;

  return (
    <div className="space-y-6" data-ui-mode={uiMode.mode}>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Shop</h1>
        <p className="max-w-2xl text-slate-600">
          Browse the fixed 24-product catalog. Validated generated images appear as they are
          delivered; every missing or invalid image stays on its local placeholder.
        </p>
      </header>

      <UiModeSwitcher mode={uiMode.mode} error={uiMode.error} />

      <div
        data-testid="catalog-layout"
        data-ui-mode={uiMode.mode}
        className={
          uiMode.mode === "alternate"
            ? "grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start"
            : "space-y-6"
        }
      >
        <div className={uiMode.mode === "alternate" ? "lg:sticky lg:top-6" : ""}>
          <CatalogFilters query={query} mode={uiMode.mode} />
        </div>

        <div className="space-y-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p aria-live="polite" className="text-sm text-slate-600">
              {countLabel}
            </p>
            {result.pageCount > 1 ? (
              <p className="text-sm text-slate-600">
                Page {result.page} of {result.pageCount}
              </p>
            ) : null}
          </div>

          {result.items.length === 0 ? (
            <section
              aria-labelledby="no-products"
              className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center"
            >
              <h2 id="no-products" className="text-xl font-semibold">
                No products found
              </h2>
              <p className="mt-2 text-slate-600">
                Try a different search or clear the filters above.
              </p>
            </section>
          ) : (
            <ul
              className={
                uiMode.mode === "alternate"
                  ? "grid gap-5 sm:grid-cols-2"
                  : "grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
              }
            >
              {result.items.map((product) => (
                <li key={product.id}>
                  <ProductCard
                    product={product}
                    imageUrl={deliverable.get(product.id)?.url ?? null}
                  />
                </li>
              ))}
            </ul>
          )}

          <CatalogPagination result={result} />
        </div>
      </div>
    </div>
  );
}
