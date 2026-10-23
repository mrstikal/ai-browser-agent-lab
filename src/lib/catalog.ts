import {
  PRODUCT_CATEGORIES,
  type Product,
  type ProductCategory,
} from "./products";

export const CATALOG_PAGE_SIZE = 6;

export type CatalogSort = "default" | "price-asc" | "price-desc";
export type CatalogStockFilter = "all" | "in";

export interface CatalogQuery {
  readonly q: string;
  readonly category: ProductCategory | null;
  readonly stock: CatalogStockFilter;
  readonly sort: CatalogSort;
  readonly page: number;
}

export type QueryValue = string | readonly string[] | null | undefined;
export type CatalogQueryInput = Readonly<Record<string, QueryValue>>;
export type CatalogQueryChange = Partial<CatalogQuery>;

export interface CatalogPage {
  readonly query: CatalogQuery;
  readonly items: readonly Product[];
  readonly total: number;
  readonly pageCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export const DEFAULT_CATALOG_QUERY: CatalogQuery = Object.freeze({
  q: "",
  category: null,
  stock: "all",
  sort: "default",
  page: 1,
});

function firstValue(value: QueryValue): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function parsePage(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  if (!Number.isFinite(page) || !Number.isSafeInteger(page)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return page > 0 ? page : 1;
}

function parseCategory(value: string | undefined): ProductCategory | null {
  return PRODUCT_CATEGORIES.find((category) => category === value) ?? null;
}

function parseStock(value: string | undefined): CatalogStockFilter {
  return value === "in" ? "in" : "all";
}

function parseSort(value: string | undefined): CatalogSort {
  return value === "price-asc" || value === "price-desc" ? value : "default";
}

export function parseCatalogQuery(input: CatalogQueryInput = {}): CatalogQuery {
  return {
    q: (firstValue(input.q) ?? "").trim(),
    category: parseCategory(firstValue(input.category)?.trim()),
    stock: parseStock(firstValue(input.stock)?.trim()),
    sort: parseSort(firstValue(input.sort)?.trim()),
    page: parsePage(firstValue(input.page)?.trim()),
  };
}

export function applyCatalogQueryChange(
  query: CatalogQuery,
  change: CatalogQueryChange,
): CatalogQuery {
  const filtersChanged =
    change.q !== undefined ||
    change.category !== undefined ||
    change.stock !== undefined ||
    change.sort !== undefined;
  const category = change.category === undefined ? query.category : change.category;
  return parseCatalogQuery({
    q: change.q ?? query.q,
    category: category ?? undefined,
    stock: change.stock ?? query.stock,
    sort: change.sort ?? query.sort,
    page: String(filtersChanged ? 1 : (change.page ?? query.page)),
  });
}

export function catalogHref(query: CatalogQuery): string {
  const normalized = parseCatalogQuery({
    q: query.q,
    category: query.category ?? undefined,
    stock: query.stock,
    sort: query.sort,
    page: String(query.page),
  });
  const params = new URLSearchParams();
  if (normalized.q) params.set("q", normalized.q);
  if (normalized.category) params.set("category", normalized.category);
  if (normalized.stock === "in") params.set("stock", "in");
  if (normalized.sort !== "default") params.set("sort", normalized.sort);
  if (normalized.page > 1) params.set("page", String(normalized.page));
  const search = params.toString();
  return search ? `/shop?${search}` : "/shop";
}

function compareProducts(left: Product, right: Product, sort: CatalogSort): number {
  if (sort !== "default") {
    const priceDifference = left.priceUsd - right.priceUsd;
    if (priceDifference !== 0) {
      return sort === "price-asc" ? priceDifference : -priceDifference;
    }
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function selectCatalogPage(
  catalog: readonly Product[],
  query: CatalogQuery,
): CatalogPage {
  const q = query.q.trim().toLowerCase();
  const filtered = catalog.filter((product) => {
    if (q && !product.name.toLowerCase().includes(q)) return false;
    if (query.category !== null && product.category !== query.category) return false;
    if (query.stock === "in" && product.stock <= 0) return false;
    return true;
  });
  const sorted = [...filtered].sort((left, right) =>
    compareProducts(left, right, query.sort),
  );
  const total = sorted.length;
  const pageCount = Math.ceil(total / CATALOG_PAGE_SIZE);
  const requestedPage = Number.isInteger(query.page) && query.page > 0 ? query.page : 1;
  const page = pageCount === 0 ? 1 : Math.min(requestedPage, pageCount);
  const start = (page - 1) * CATALOG_PAGE_SIZE;
  const items = sorted.slice(start, start + CATALOG_PAGE_SIZE);
  return {
    query: { ...query, page },
    items,
    total,
    pageCount,
    page,
    pageSize: CATALOG_PAGE_SIZE,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}
