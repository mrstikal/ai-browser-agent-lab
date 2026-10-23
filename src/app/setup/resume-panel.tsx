"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProductId } from "@/lib/products";
import type { ImageJobStatus } from "@/server/image-state";
import { guardedJsonFetch, readErrorMessage } from "./guard-fetch";

interface ResumeQuote {
  readonly fingerprint: string;
  readonly targets: readonly ProductId[];
  readonly imageCount: number;
  readonly unitPriceUsd: string;
  readonly baseUsd: string;
  readonly worstCaseUsd: string;
  readonly startingBalanceBaseUsd: string;
  readonly startingBalanceWorstCaseUsd: string;
  readonly perRequestFloorUsd: string;
  readonly providerSlug: string;
}

export interface ResumePanelProps {
  readonly jobStatus: ImageJobStatus | null;
  readonly missingTargets: readonly ProductId[];
  readonly retryableTargets: readonly ProductId[];
  readonly terminal: boolean;
}

export function ResumePanel({
  jobStatus,
  missingTargets,
  retryableTargets,
  terminal,
}: ResumePanelProps) {
  const router = useRouter();
  const [review, setReview] = useState<ResumeQuote | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resumable =
    terminal &&
    (missingTargets.length > 0 || retryableTargets.length > 0) &&
    (jobStatus === "failed" ||
      jobStatus === "interrupted" ||
      jobStatus === "stopped_by_user" ||
      jobStatus === "completed");

  if (!resumable) return null;

  async function reviewTargets(mode: "missing" | "retry") {
    const targets = mode === "missing" ? missingTargets : retryableTargets;
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setReview(null);
    setConfirmed(false);
    try {
      const response = await guardedJsonFetch("/api/images/quote", {
        method: "POST",
        body: { selectedIds: targets },
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const payload = (await response.json()) as {
        quote: Omit<ResumeQuote, "targets">;
      };
      setReview({ ...payload.quote, targets });
    } catch {
      setError("The resume quote could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  async function startResume() {
    if (!review) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await guardedJsonFetch("/api/images/job/start", {
        method: "POST",
        body: {
          confirm: true,
          fingerprint: review.fingerprint,
          selectedIds: review.targets,
        },
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        setReview(null);
        router.refresh();
        return;
      }
      setMessage(
        "Batch queued for the approved targets only. Progress updates here; nothing else is requested.",
      );
      setReview(null);
      setConfirmed(false);
      router.refresh();
    } catch {
      setError("The resume batch could not be started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-700">
          Resume or retry
        </h3>
        <p className="text-sm text-slate-600">
          Every resume needs a fresh quote and explicit confirmation; valid images are never
          re-requested.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {missingTargets.length > 0 ? (
          <button
            type="button"
            onClick={() => void reviewTargets("missing")}
            disabled={busy}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Resume missing ({missingTargets.length})
          </button>
        ) : null}
        {retryableTargets.length > 0 ? (
          <button
            type="button"
            onClick={() => void reviewTargets("retry")}
            disabled={busy}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Retry failed ({retryableTargets.length})
          </button>
        ) : null}
      </div>

      {review ? (
        <div className="space-y-2 rounded border border-slate-300 bg-white p-3">
          <p className="text-sm text-slate-700">
            {review.imageCount} target(s) at {review.unitPriceUsd} USD each from{" "}
            {review.providerSlug}: base {review.baseUsd} USD, worst case {review.worstCaseUsd}{" "}
            USD, indicative starting balance {review.startingBalanceBaseUsd} USD (floor{" "}
            {review.perRequestFloorUsd} USD).
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            I reviewed and approve only these targets at the current price.
          </label>
          <button
            type="button"
            onClick={() => void startResume()}
            disabled={!confirmed || busy}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Starting..." : "Confirm and start"}
          </button>
        </div>
      ) : null}

      {message ? (
        <p role="status" className="text-sm text-emerald-700">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}