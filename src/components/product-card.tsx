import Image from "next/image";
import Link from "next/link";
import { formatUsd } from "@/lib/format";
import type { Product } from "@/lib/products";

export function ProductCard({
  product,
  imageUrl = null,
}: {
  product: Product;
  imageUrl?: string | null;
}) {
  const inStock = product.stock > 0;
  const nameId = `product-${product.id}-name`;

  return (
    <article
      data-product-id={product.id}
      aria-labelledby={nameId}
      className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={product.name}
          width={768}
          height={768}
          unoptimized
          className="aspect-square w-full border-b border-slate-200 bg-slate-100 object-cover"
        />
      ) : (
        <div
          role="img"
          aria-label={`Placeholder image for ${product.name}`}
          className="flex aspect-square items-center justify-center border-b border-slate-200 bg-slate-100"
        >
          <span aria-hidden="true" className="text-4xl font-semibold text-slate-400">
            {product.name.charAt(0)}
          </span>
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {product.category}
        </p>
        <h2 id={nameId} className="text-lg font-semibold leading-snug">
          <Link href={`/shop/products/${product.slug}`} className="hover:underline">
            {product.name}
          </Link>
        </h2>
        <p className="text-lg font-semibold">{formatUsd(product.priceUsd)}</p>
        <p
          className={`text-sm font-medium ${inStock ? "text-emerald-700" : "text-rose-700"}`}
        >
          {inStock ? "In stock" : "Out of stock"}
        </p>
      </div>
    </article>
  );
}
