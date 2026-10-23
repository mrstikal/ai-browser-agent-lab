import Link from "next/link";
import { catalogHref, type CatalogPage } from "@/lib/catalog";

const linkClass =
  "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-500 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-slate-300";
const disabledClass =
  "rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-400";

export function CatalogPagination({ result }: { result: CatalogPage }) {
  if (result.pageCount <= 1) return null;

  const pages = Array.from({ length: result.pageCount }, (_, index) => index + 1);
  const hrefFor = (page: number) => catalogHref({ ...result.query, page });

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4"
    >
      <div>
        {result.hasPrevious ? (
          <Link href={hrefFor(result.page - 1)} className={linkClass}>
            Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>
            Previous
          </span>
        )}
      </div>
      <ol className="flex flex-wrap items-center gap-1">
        {pages.map((page) => (
          <li key={page}>
            {page === result.page ? (
              <span
                aria-current="page"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
              >
                {page}
              </span>
            ) : (
              <Link href={hrefFor(page)} aria-label={`Page ${page}`} className={linkClass}>
                {page}
              </Link>
            )}
          </li>
        ))}
      </ol>
      <div>
        {result.hasNext ? (
          <Link href={hrefFor(result.page + 1)} className={linkClass}>
            Next
          </Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
