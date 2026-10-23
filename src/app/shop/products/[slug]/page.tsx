import { PageStub } from "@/components/page-stub";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  return (
    <PageStub
      title="Product details"
      description="Product details will be rendered here once the catalog fixture is implemented."
    >
      <p className="text-sm text-slate-600">
        Requested slug: <code className="rounded bg-slate-200 px-1.5 py-0.5">{slug}</code>
      </p>
    </PageStub>
  );
}
