import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatUsd } from "@/lib/format";
import { findProductBySlug } from "@/lib/products";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = findProductBySlug(slug);
  if (!product) return { title: "Product not found" };
  return {
    title: product.name,
    description: product.description,
  };
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const product = findProductBySlug(slug);
  if (!product) notFound();

  const inStock = product.stock > 0;

  return (
    <article
      data-product-id={product.id}
      aria-labelledby="product-name"
      className="space-y-6"
    >
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <li>
            <Link href="/shop" className="hover:text-slate-950 hover:underline">
              Shop
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <span aria-current="page">{product.name}</span>
          </li>
        </ol>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        <div
          role="img"
          aria-label={`Placeholder image for ${product.name}`}
          className="flex aspect-square items-center justify-center rounded-xl border border-slate-200 bg-slate-100"
        >
          <span aria-hidden="true" className="text-6xl font-semibold text-slate-400">
            {product.name.charAt(0)}
          </span>
        </div>

        <div className="space-y-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {product.category}
          </p>
          <h1
            id="product-name"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            {product.name}
          </h1>
          <p className="text-2xl font-semibold">{formatUsd(product.priceUsd)}</p>
          <p
            className={`text-sm font-medium ${inStock ? "text-emerald-700" : "text-rose-700"}`}
          >
            {inStock ? `In stock (${product.stock} available)` : "Out of stock"}
          </p>
          <p className="max-w-2xl text-slate-600">{product.description}</p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              href={`/forms/inquiry?productId=${encodeURIComponent(product.id)}`}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
            >
              Ask about {product.name}
            </Link>
            <Link
              href="/shop"
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-500 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-slate-300"
            >
              Back to shop
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
