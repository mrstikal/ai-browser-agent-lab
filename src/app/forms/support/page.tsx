import type { Metadata } from "next";
import { UiModeSwitcher } from "@/components/ui-mode-switcher";
import { createStorage } from "@/server/storage";
import { loadUiModeView } from "@/server/ui-mode";
import { SupportForm } from "./support-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Support request",
};

export default async function SupportPage() {
  const uiMode = await loadUiModeView(createStorage());

  return (
    <div className="space-y-6" data-ui-mode={uiMode.mode}>
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
      <UiModeSwitcher mode={uiMode.mode} error={uiMode.error} />
      <SupportForm mode={uiMode.mode} />
    </div>
  );
}
