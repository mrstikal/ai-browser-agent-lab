import Link from "next/link";

const entryPoints = [
  {
    href: "/setup",
    title: "Setup",
    description: "Enter an OpenRouter key and prepare the generated product images.",
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

export default function HomePage() {
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
          This shell is the foundation for the setup, catalog, forms, and agent phases.
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
