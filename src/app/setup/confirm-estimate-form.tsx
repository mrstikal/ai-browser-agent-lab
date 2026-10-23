"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { guardedJsonFetch, readErrorMessage } from "./guard-fetch";

export interface ConfirmEstimateFormProps {
  readonly fingerprint: string;
  readonly imageCount: number;
  readonly baseUsd: string;
  readonly worstCaseUsd: string;
  readonly startingBalanceBaseUsd: string;
  readonly startingBalanceWorstCaseUsd: string;
}

export function ConfirmEstimateForm({
  fingerprint,
  imageCount,
  baseUsd,
  worstCaseUsd,
  startingBalanceBaseUsd,
  startingBalanceWorstCaseUsd,
}: ConfirmEstimateFormProps) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await guardedJsonFetch("/api/images/job/start", {
        method: "POST",
        body: { confirm: true, fingerprint },
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        router.refresh();
        return;
      }
      setMessage(
        "Batch queued at the displayed price. Progress updates appear below; no other targets are requested.",
      );
      router.refresh();
    } catch {
      setError("The estimate could not be confirmed.");
    } finally {
      setBusy(false);
      setConfirmed(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="confirm-estimate-form">
      <ul className="space-y-1 text-sm text-slate-700">
        <li>
          Images in this batch: <strong>{imageCount}</strong>
        </li>
        <li>
          Base estimate (one attempt per image): <strong>{baseUsd} USD</strong>
        </li>
        <li>
          Worst case (up to two retries per image): <strong>{worstCaseUsd} USD</strong>
        </li>
        <li>
          Indicative balance keeping $1.00 before each request:{" "}
          <strong>{startingBalanceBaseUsd} USD</strong> (worst case{" "}
          {startingBalanceWorstCaseUsd} USD)
        </li>
      </ul>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5"
        />
        I have reviewed the missing images, the current unit price, and the indicative starting
        balance. Confirming starts the batch and may incur the displayed charges.
      </label>
      <button
        type="submit"
        disabled={!confirmed || busy}
        className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Starting..." : "Confirm and start batch"}
      </button>
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
    </form>
  );
}
