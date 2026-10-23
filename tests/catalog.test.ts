import { describe, expect, it } from "vitest";
import {
  CATALOG_PAGE_SIZE,
  DEFAULT_CATALOG_QUERY,
  applyCatalogQueryChange,
  catalogHref,
  parseCatalogQuery,
  selectCatalogPage,
  type CatalogPage,
} from "../src/lib/catalog";
import { products, type Product } from "../src/lib/products";

function ids(page: CatalogPage): string[] {
  return page.items.map((product) => product.id);
}

describe("catalog pagination", () => {
  it("uses six-item pages and the four default pages", () => {
    expect(CATALOG_PAGE_SIZE).toBe(6);
    expect(parseCatalogQuery({})).toEqual(DEFAULT_CATALOG_QUERY);
    expect(selectCatalogPage(products, parseCatalogQuery({})).pageCount).toBe(4);

    const expectedPages = [
      ["P01", "P02", "P03", "P04", "P05", "P06"],
      ["P07", "P08", "P09", "P10", "P11", "P12"],
      ["P13", "P14", "P15", "P16", "P17", "P18"],
      ["P19", "P20", "P21", "P22", "P23", "P24"],
    ] as const;

    expectedPages.forEach((expected, index) => {
      const page = selectCatalogPage(
        products,
        parseCatalogQuery({ page: String(index + 1) }),
      );
      expect(page.total).toBe(24);
      expect(page.page).toBe(index + 1);
      expect(ids(page)).toEqual(expected);
    });
  });

  it("filters the full fixture before slicing a page", () => {
    const page2 = selectCatalogPage(
      products,
      parseCatalogQuery({ stock: "in", page: "2" }),
    );
    expect(page2.total).toBe(20);
    expect(page2.pageCount).toBe(4);
    expect(ids(page2)).toEqual(["P08", "P10", "P11", "P12", "P13", "P14"]);
  });

  it("clamps an integer beyond the last page", () => {
    const last = selectCatalogPage(products, parseCatalogQuery({ page: "99" }));
    expect(last.page).toBe(4);
    expect(last.query.page).toBe(4);
    expect(ids(last)).toEqual(["P19", "P20", "P21", "P22", "P23", "P24"]);
    expect(last.hasPrevious).toBe(true);
    expect(last.hasNext).toBe(false);
  });

  it.each(["1000000000000000", "9".repeat(100)])(
    "clamps the oversized integer page %s to the last page",
    (page) => {
      const last = selectCatalogPage(products, parseCatalogQuery({ page }));
      expect(last.page).toBe(4);
      expect(last.query.page).toBe(4);
      expect(ids(last)).toEqual(["P19", "P20", "P21", "P22", "P23", "P24"]);
    },
  );

  it("uses page 1 and no pages for zero results", () => {
    const zero = selectCatalogPage(
      products,
      parseCatalogQuery({ q: "zzz", page: "3" }),
    );
    expect(zero.total).toBe(0);
    expect(zero.page).toBe(1);
    expect(zero.query.page).toBe(1);
    expect(zero.pageCount).toBe(0);
    expect(zero.items).toEqual([]);
    expect(zero.hasPrevious).toBe(false);
    expect(zero.hasNext).toBe(false);
    expect(catalogHref(zero.query)).toBe("/shop?q=zzz");
  });

  it("reports navigation flags on the first and last pages", () => {
    const first = selectCatalogPage(products, parseCatalogQuery({}));
    expect(first.hasPrevious).toBe(false);
    expect(first.hasNext).toBe(true);
    const last = selectCatalogPage(products, parseCatalogQuery({ page: "4" }));
    expect(last.hasPrevious).toBe(true);
    expect(last.hasNext).toBe(false);
  });
});

describe("catalog filtering", () => {
  it("matches trimmed, case-insensitive product names only", () => {
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ q: "  HEADPHONES " }))),
    ).toEqual(["P01", "P13"]);
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ q: "wireless" }))),
    ).toEqual(["P01", "P06"]);
    expect(ids(selectCatalogPage(products, parseCatalogQuery({ q: "usb-c" })))).toEqual([
      "P10",
    ]);
    expect(ids(selectCatalogPage(products, parseCatalogQuery({ q: "lamp" })))).toEqual([
      "P03",
    ]);
    expect(selectCatalogPage(products, parseCatalogQuery({ q: "audio" })).total).toBe(0);
    expect(selectCatalogPage(products, parseCatalogQuery({ q: "   " })).total).toBe(24);
  });

  it("accepts only the four known categories", () => {
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ category: "Audio" }))),
    ).toEqual(["P01", "P05", "P09", "P13", "P17", "P21"]);
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ category: "Home" }))),
    ).toEqual(["P03", "P07", "P11", "P15", "P19", "P23"]);
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ category: "Computing" }))),
    ).toEqual(["P02", "P06", "P10", "P14", "P18", "P22"]);
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ category: "Accessories" }))),
    ).toEqual(["P04", "P08", "P12", "P16", "P20", "P24"]);
    expect(
      selectCatalogPage(products, parseCatalogQuery({ category: "audio" })).total,
    ).toBe(24);
    expect(
      selectCatalogPage(products, parseCatalogQuery({ category: "Unknown" })).total,
    ).toBe(24);
  });

  it("filters in-stock products and ignores invalid stock values", () => {
    const inStock = selectCatalogPage(products, parseCatalogQuery({ stock: "in" }));
    expect(inStock.total).toBe(20);
    expect(ids(inStock)).toEqual(["P01", "P02", "P03", "P05", "P06", "P07"]);
    for (const id of ["P04", "P09", "P15", "P18"]) {
      expect(inStock.items.some((product) => product.id === id)).toBe(false);
    }
    expect(selectCatalogPage(products, parseCatalogQuery({ stock: "out" })).total).toBe(
      24,
    );
    expect(selectCatalogPage(products, parseCatalogQuery({ stock: "IN" })).total).toBe(
      24,
    );
  });

  it("applies category, stock, and price sorting together", () => {
    const result = selectCatalogPage(
      products,
      parseCatalogQuery({ category: "Audio", stock: "in", sort: "price-asc" }),
    );
    expect(result.total).toBe(5);
    expect(ids(result)).toEqual(["P21", "P05", "P01", "P13", "P17"]);
  });
});

describe("catalog sorting", () => {
  it("sorts numerically by price ascending and descending", () => {
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ sort: "price-asc" }))),
    ).toEqual(["P16", "P19", "P07", "P20", "P08", "P12"]);
    expect(
      ids(
        selectCatalogPage(
          products,
          parseCatalogQuery({ sort: "price-asc", page: "2" }),
        ),
      ),
    ).toEqual(["P06", "P11", "P21", "P10", "P03", "P15"]);
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ sort: "price-desc" }))),
    ).toEqual(["P17", "P24", "P13", "P14", "P02", "P01"]);
  });

  it("uses ID as the stable price tie-breaker", () => {
    const base: Product = products[0];
    const tied: readonly Product[] = [
      { ...base, id: "P02", priceUsd: 50 },
      { ...base, id: "P01", priceUsd: 50 },
    ];
    expect(
      ids(selectCatalogPage(tied, parseCatalogQuery({ sort: "price-asc" }))),
    ).toEqual(["P01", "P02"]);
    expect(
      ids(selectCatalogPage(tied, parseCatalogQuery({ sort: "price-desc" }))),
    ).toEqual(["P01", "P02"]);
    expect(ids(selectCatalogPage(tied, parseCatalogQuery({})))).toEqual([
      "P01",
      "P02",
    ]);
  });

  it("ignores unknown sort values", () => {
    expect(
      ids(selectCatalogPage(products, parseCatalogQuery({ sort: "price" }))),
    ).toEqual(["P01", "P02", "P03", "P04", "P05", "P06"]);
  });
});

describe("catalog query normalization", () => {
  it("normalizes known values and defaults unknown values", () => {
    expect(
      parseCatalogQuery({
        q: "  Lamp  ",
        category: "Home",
        stock: "in",
        sort: "price-asc",
        page: "2",
      }),
    ).toEqual({
      q: "Lamp",
      category: "Home",
      stock: "in",
      sort: "price-asc",
      page: 2,
    });
    expect(
      parseCatalogQuery({ category: "audio", stock: "out", sort: "price" }),
    ).toEqual({
      q: "",
      category: null,
      stock: "all",
      sort: "default",
      page: 1,
    });
  });

  it("takes the first value from repeated query parameters", () => {
    expect(
      parseCatalogQuery({
        q: ["lamp", "mouse"],
        category: ["Home"],
        stock: ["in"],
        sort: ["price-desc"],
        page: ["2", "3"],
      }),
    ).toEqual({
      q: "lamp",
      category: "Home",
      stock: "in",
      sort: "price-desc",
      page: 2,
    });
  });

  it.each(["0", "-1", "abc", "1.5", "", "  "])(
    "normalizes page %j to 1",
    (page) => {
      expect(parseCatalogQuery({ page }).page).toBe(1);
    },
  );

  it("resets the page when search or a filter changes", () => {
    const page3 = parseCatalogQuery({ page: "3" });
    expect(applyCatalogQueryChange(page3, { q: "lamp" })).toMatchObject({
      q: "lamp",
      page: 1,
    });
    expect(applyCatalogQueryChange(page3, { category: "Audio" }).page).toBe(1);
    expect(applyCatalogQueryChange(page3, { stock: "in" }).page).toBe(1);
    expect(applyCatalogQueryChange(page3, { sort: "price-asc" }).page).toBe(1);
    expect(applyCatalogQueryChange(page3, { q: "lamp", page: 2 }).page).toBe(1);
    expect(
      applyCatalogQueryChange(
        parseCatalogQuery({ category: "Audio", page: "3" }),
        { category: null },
      ),
    ).toMatchObject({ category: null, page: 1 });
  });

  it("preserves filters when only the page changes", () => {
    const query = parseCatalogQuery({
      q: "headphones",
      category: "Audio",
      stock: "in",
      sort: "price-asc",
      page: "1",
    });
    expect(applyCatalogQueryChange(query, { page: 2 })).toEqual({
      q: "headphones",
      category: "Audio",
      stock: "in",
      sort: "price-asc",
      page: 2,
    });
  });
});

describe("catalogHref", () => {
  it("builds reproducible URLs and preserves active options", () => {
    expect(catalogHref(DEFAULT_CATALOG_QUERY)).toBe("/shop");
    expect(
      catalogHref(
        parseCatalogQuery({
          category: "Audio",
          stock: "in",
          sort: "price-asc",
          page: "1",
        }),
      ),
    ).toBe("/shop?category=Audio&stock=in&sort=price-asc");
    expect(
      catalogHref(
        parseCatalogQuery({
          category: "Audio",
          stock: "in",
          sort: "price-asc",
          page: "2",
        }),
      ),
    ).toBe("/shop?category=Audio&stock=in&sort=price-asc&page=2");
    expect(catalogHref(parseCatalogQuery({ q: "  wireless headphones " }))).toBe(
      "/shop?q=wireless+headphones",
    );
    expect(
      catalogHref(
        applyCatalogQueryChange(
          parseCatalogQuery({ category: "Audio", sort: "price-asc", page: "3" }),
          { q: "headphones" },
        ),
      ),
    ).toBe("/shop?q=headphones&category=Audio&sort=price-asc");
  });
});
