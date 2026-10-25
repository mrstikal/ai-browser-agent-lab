import Link from "next/link";
import type { Metadata } from "next";
import { createStorage } from "@/server/storage";
import { loadImageProgress } from "@/server/image-progress";
import { loadSetupView } from "@/server/setup-view";
import type { SetupStatus } from "@/server/image-state";
import { ConfirmEstimateForm } from "./confirm-estimate-form";
import { KeyForm } from "./key-form";
import { ModelForm } from "./model-form";
import { ProgressPanel } from "./progress-panel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Setup",
};

const STATUS_LABELS: Record<SetupStatus, string> = {
  generating: "Image generation is in progress",
  stopping: "Stopping the current batch",
  completed: "All 24 images are ready",
  incomplete: "Image set is incomplete",
  not_configured: "API key needed",
  ready_to_generate: "Ready to generate images",
};

export default async function SetupPage() {
  const view = await loadSetupView(createStorage());
  const progress = await loadImageProgress(createStorage());

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          First-run wizard
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Setup</h1>
        <p className="max-w-2xl text-slate-600">
          Validate an OpenRouter key, choose image and browser models, and review the current
          image estimate. Quote and key checks are non-billable metadata requests; image
          generation is a separate paid batch that starts only after you explicitly confirm the
          displayed estimate.
        </p>
      </header>

      {view.setupError ? (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {view.setupError}
        </p>
      ) : null}
      {view.settingsError ? (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {view.settingsError}
        </p>
      ) : null}

      <section aria-labelledby="setup-status-heading" className="space-y-2 rounded-lg border border-slate-200 bg-white p-5">
        <h2 id="setup-status-heading" className="text-lg font-semibold">
          Current state
        </h2>
        <p data-testid="setup-status" className="text-sm text-slate-700">
          {STATUS_LABELS[view.setup.status]}
        </p>
        <p data-testid="image-progress" className="text-sm text-slate-700">
          {view.setup.validImageCount} of {view.setup.totalImageCount} active images validate
          {view.setup.missingImageIds.length > 0
            ? `; missing: ${view.setup.missingImageIds.join(", ")}`
            : ""}
        </p>
        {view.setup.job.status ? (
          <p className="text-sm text-slate-600">
            Last job status: {view.setup.job.status}
            {view.setup.job.failedRegeneration ? " (completed images, last batch did not finish)" : ""}
          </p>
        ) : null}
      </section>

      <KeyForm keyAvailable={view.key.keyAvailable} source={view.key.source} />
      {view.key.error ? (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {view.key.error}
        </p>
      ) : null}

      <ModelForm image={view.settings.image} browser={view.settings.browser} />

      <section aria-labelledby="quote-heading" className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <div className="space-y-1">
          <h2 id="quote-heading" className="text-lg font-semibold">
            Image estimate
          </h2>
          <p className="text-sm text-slate-600">
            The estimate is recomputed from live OpenRouter model metadata on every load. Unknown,
            stale, or unverified pricing blocks generation instead of showing $0.
          </p>
        </div>

        {view.setupError ? (
          <p
            data-testid="quote-state"
            data-code="image-state-unreadable"
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            Saved image state is unreadable, so no estimate can be shown. Inspect the image
            manifest before continuing.
          </p>
        ) : view.quote === null ? (
          <p data-testid="quote-state" data-code="completed" className="text-sm text-slate-700">
            All 24 images are valid. A new quote appears only for explicitly selected regeneration
            targets.
          </p>
        ) : view.quote.ok ? (
          <div className="space-y-4">
            <p data-testid="quote-state" data-code="ok" className="text-sm text-slate-700">
              {view.quote.quote.imageCount} target image(s) at{" "}
              {view.quote.quote.unitPriceUsd} USD each from provider{" "}
              {view.quote.quote.providerSlug}; base {view.quote.quote.baseUsd} USD, worst case{" "}
              {view.quote.quote.worstCaseUsd} USD.
            </p>
            {view.setup.status === "generating" || view.setup.status === "stopping" ? (
              <p role="status" className="text-sm text-slate-700">
                A batch is {view.setup.status}. Confirmation stays disabled until it settles.
              </p>
            ) : (
            <ConfirmEstimateForm
              key={view.quote.quote.fingerprint}
              fingerprint={view.quote.quote.fingerprint}
              imageCount={view.quote.quote.imageCount}
              baseUsd={view.quote.quote.baseUsd}
              worstCaseUsd={view.quote.quote.worstCaseUsd}
              startingBalanceBaseUsd={view.quote.quote.startingBalanceBaseUsd}
              startingBalanceWorstCaseUsd={view.quote.quote.startingBalanceWorstCaseUsd}
            />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p
              data-testid="quote-state"
              data-code={view.quote.code}
              role="alert"
              className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            >
              {view.quote.message}
            </p>
            <p className="text-xs text-slate-500">
              Quote code: <code>{view.quote.code}</code>. No paid request was made.
            </p>
          </div>
        )}
      </section>

      <ProgressPanel key={progress.job.jobId ?? "no-job"} initial={progress} />

      <p className="text-sm text-slate-600">
        The catalog stays browsable with placeholders while images are missing:{" "}
        <Link href="/shop" className="font-medium underline">
          open the shop
        </Link>
        .
      </p>
    </div>
  );
}
