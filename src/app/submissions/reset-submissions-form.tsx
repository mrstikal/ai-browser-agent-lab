"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { guardedJsonFetch, readErrorMessage } from "@/app/setup/guard-fetch";

export function ResetSubmissionsForm({
  supportCount,
  inquiryCount,
}: {
  readonly supportCount: number;
  readonly inquiryCount: number;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await guardedJsonFetch("/api/submissions/reset", {
        method: "POST",
        body: { confirm: true },
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const payload = (await response.json()) as {
        removed: { support: number; inquiry: number };
      };
      setMessage(
        `Removed ${payload.removed.support} support and ${payload.removed.inquiry} inquiry record(s). Images, keys, and settings were not touched.`,
      );
      setConfirmed(false);
      router.refresh();
    } catch {
      setError("The submissions could not be reset.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-rose-300 bg-rose-50 p-5">
      <h2 className="text-lg font-semibold text-rose-900">Reset submissions</h2>
      <p className="text-sm text-rose-900">
        This removes {supportCount} support and {inquiryCount} inquiry record(s) only. Images,
        API keys, settings, and agent state are not affected.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={busy}
          className="mt-0.5"
          data-testid="reset-confirm"
        />
        I understand this permanently removes all local form submissions.
      </label>
      <button
        type="button"
        onClick={() => void reset()}
        disabled={!confirmed || busy || supportCount + inquiryCount === 0}
        className="rounded bg-rose-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        data-testid="reset-submissions"
      >
        {busy ? "Resetting..." : "Reset submissions"}
      </button>
      {message ? (
        <p role="status" className="text-sm text-emerald-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
