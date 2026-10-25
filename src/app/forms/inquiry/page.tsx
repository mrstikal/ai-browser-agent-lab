import type { Metadata } from "next";
import { UiModeSwitcher } from "@/components/ui-mode-switcher";
import { products } from "@/lib/products";
import { createStorage } from "@/server/storage";
import { loadUiModeView } from "@/server/ui-mode";
import { InquiryForm } from "./inquiry-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Product inquiry",
};

interface InquiryPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InquiryPage({ searchParams }: InquiryPageProps) {
  const params = await searchParams;
  const raw = typeof params.productId === "string" ? params.productId : "";
  const initialProductId =
    products.find((product) => product.id === raw)?.id ?? "";
  const uiMode = await loadUiModeView(createStorage());

  return (
    <div className="space-y-6" data-ui-mode={uiMode.mode}>
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Local test form
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Product inquiry</h1>
        <p className="max-w-2xl text-slate-600">
          Ask about one of the fixed catalog products. A product detail page preselects its
          product; only known product IDs are accepted.
        </p>
      </header>
      <UiModeSwitcher mode={uiMode.mode} error={uiMode.error} />
      <InquiryForm initialProductId={initialProductId} mode={uiMode.mode} />
    </div>
  );
}
