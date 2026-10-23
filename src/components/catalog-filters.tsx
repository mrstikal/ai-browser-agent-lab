import Link from "next/link";
import type { CatalogQuery } from "@/lib/catalog";
import { PRODUCT_CATEGORIES } from "@/lib/products";

const fieldClass =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200";
const labelClass = "text-sm font-medium text-slate-700";

export function CatalogFilters({ query }: { query: CatalogQuery }) {
  const hasActiveFilters =
    query.q !== "" ||
    query.category !== null ||
    query.stock === "in" ||
    query.sort !== "default";

  return (
    <form
      method="get"
      action="/shop"
      role="search"
      aria-label="Catalog filters"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="catalog-q" className={labelClass}>
            Search products
          </label>
          <input
            id="catalog-q"
            name="q"
            type="search"
            defaultValue={query.q}
            placeholder="Search by product name"
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="catalog-category" className={labelClass}>
            Category
          </label>
          <select
            id="catalog-category"
            name="category"
            defaultValue={query.category ?? ""}
            className={fieldClass}
          >
            <option value="">All categories</option>
            {PRODUCT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="catalog-sort" className={labelClass}>
            Sort
          </label>
          <select
            id="catalog-sort"
            name="sort"
            defaultValue={query.sort}
            className={fieldClass}
          >
            <option value="default">Default order</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
          </select>
        </div>
        <div className="flex items-end">
          <div className="flex items-center gap-2 pb-2">
            <input
              id="catalog-stock"
              name="stock"
              type="checkbox"
              value="in"
              defaultChecked={query.stock === "in"}
              className="h-4 w-4 rounded border-slate-300"
            />
            <label htmlFor="catalog-stock" className="text-sm font-medium text-slate-700">
              In stock only
            </label>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
        >
          Apply filters
        </button>
        {hasActiveFilters ? (
          <Link
            href="/shop"
            className="text-sm font-medium text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline"
          >
            Clear filters
          </Link>
        ) : null}
      </div>
    </form>
  );
}
