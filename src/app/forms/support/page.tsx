import type { Metadata } from "next";
import { SupportForm } from "./support-form";

export const metadata: Metadata = {
  title: "Support request",
};

export default function SupportPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Local test form
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Support request</h1>
        <p className="max-w-2xl text-slate-600">
          Fill in the fields, review the whole request, confirm that this is a local test
          submission, and only then submit. Nothing is stored until the final submit.
        </p>
      </header>
      <SupportForm />
    </div>
  );
}
