import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AI Browser Agent Lab",
    template: "%s | AI Browser Agent Lab",
  },
  description: "Local storefront and browser-agent proof of concept.",
};

const navigation = [
  { href: "/setup", label: "Setup" },
  { href: "/shop", label: "Shop" },
  { href: "/forms/support", label: "Support" },
  { href: "/forms/inquiry", label: "Inquiry" },
  { href: "/submissions", label: "Submissions" },
  { href: "/agent", label: "Agent" },
] as const;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              AI Browser Agent Lab
            </Link>
            <nav aria-label="Main navigation">
              <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {navigation.map((item) => (
                  <li key={item.href}>
                    <Link className="text-slate-600 hover:text-slate-950" href={item.href}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-slate-500">
          Local proof of concept. No production checkout, payments, or authentication.
        </footer>
      </body>
    </html>
  );
}
