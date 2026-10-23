import Link from "next/link";
import { redirect } from "next/navigation";
import { createStorage } from "@/server/storage";
import { loadSetupView } from "@/server/setup-view";

export const dynamic = "force-dynamic";

const entryPoints = [
  {
    href: "/setup",
    title: "Setup",
    description: "Validate the key, choose models, and review the image estimate.",
  },
  {
    href: "/shop",
    title: "Shop",
    description: "Browse the fixed 24-product catalog with local image placeholders.",
  },
  {
    href: "/forms/support",
    title: "Support form",
    description: "Submit a local test support request and receive a confirmation ID.",
  },
  {
    href: "/forms/inquiry",
    title: "Product inquiry",
    description: "Ask about a product through a local test inquiry form.",
  },
  {
    href: "/agent",
    title: "Agent dashboard",
    description: "Run and inspect the local Chromium browser agent.",
  },
] as const;

export default async function HomePage() {
  const view = await loadSetupView(createStorage(), { skipQuote: true });
  if (view.setupError || view.setup.status !== "completed") {
    redirect("/setup");
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Local proof of concept
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          AI Browser Agent Lab
        </h1>
        <p className="max-w-2xl text-slate-600">
          A local storefront with generated product images and a real Chromium browser agent.
          All 24 images validate, so the setup wizard is complete.
        </p>
      </section>

      <section aria-labelledby="entry-points" className="space-y-3">
        <h2 id="entry-points" className="text-xl font-semibold">
          Entry points
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {entryPoints.map((entry) => (
            <li key={entry.href}>
              <Link
                href={entry.href}
                className="block rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:border-slate-400"
              >
                <span className="font-medium">{entry.title}</span>
                <span className="mt-1 block text-sm text-slate-600">{entry.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
