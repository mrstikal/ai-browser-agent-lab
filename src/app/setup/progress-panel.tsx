"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ImageJobStatus } from "@/server/image-state";
import type { ImageProgressSnapshot } from "@/server/image-progress";
import { guardedJsonFetch, readErrorMessage } from "@/app/setup/guard-fetch";
import { ResumePanel } from "./resume-panel";

const JOB_STATUS_LABELS: Record<ImageJobStatus, string> = {
  queued: "Queued",
  running: "Generating",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted by restart",
  stopped_by_user: "Stopped by user",
};

export interface ProgressPanelProps {
  readonly initial: ImageProgressSnapshot;
}

export function ProgressPanel({ initial }: ProgressPanelProps) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [connection, setConnection] = useState<"connecting" | "live" | "polling">(
    "connecting",
  );
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const apply = (next: ImageProgressSnapshot) => {
      if (!disposed) setSnapshot(next);
    };

    const startPolling = () => {
      if (disposed || pollTimer !== null) return;
      setConnection("polling");
      const poll = async () => {
        try {
          const response = await fetch("/api/images/progress", {
            cache: "no-store",
          });
          if (!response.ok) {
            setError("Progress is temporarily unreadable; retrying.");
            return;
          }
          setError(null);
          apply((await response.json()) as ImageProgressSnapshot);
        } catch {
          setError("Progress is temporarily unreachable; retrying.");
        }
      };
      void poll();
      pollTimer = setInterval(() => void poll(), 2000);
    };

    source = new EventSource("/api/images/progress/stream");
    source.addEventListener("open", () => {
      setConnection("live");
      setError(null);
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });
    source.addEventListener("snapshot", (event) => {
      try {
        apply(JSON.parse((event as MessageEvent<string>).data) as ImageProgressSnapshot);
        setConnection("live");
      } catch {
        // Ignore malformed events; the next snapshot or poll recovers.
      }
    });
    source.addEventListener("error", () => {
      // Keep EventSource alive so its native reconnect can recover; the GET
      // fallback keeps the UI current meanwhile.
      setConnection("polling");
      startPolling();
    });

    return () => {
      disposed = true;
      source?.close();
      if (pollTimer !== null) clearInterval(pollTimer);
    };
  }, []);

  async function stopBatch() {
    const jobId = snapshot.job.jobId;
    if (!jobId) return;
    setStopping(true);
    setError(null);
    setMessage(null);
    try {
      const response = await guardedJsonFetch("/api/images/job/stop", {
        method: "POST",
        body: { jobId },
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const payload = (await response.json()) as { applied: boolean; status: string | null };
      setMessage(
        payload.applied
          ? "Stop requested. The in-flight request is allowed to settle; no next request will be sent."
          : `Stop not applied (${payload.status ?? "no active job"}).`,
      );
      router.refresh();
    } catch {
      setError("The stop request could not be sent.");
    } finally {
      setStopping(false);
    }
  }

  const active =
    snapshot.job.status === "queued" || snapshot.job.status === "running";
  const terminal =
    snapshot.job.status === "completed" ||
    snapshot.job.status === "failed" ||
    snapshot.job.status === "interrupted" ||
    snapshot.job.status === "stopped_by_user";

  return (
    <section
      aria-labelledby="progress-heading"
      className="space-y-5 rounded-lg border border-slate-200 bg-white p-5"
      data-testid="progress-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="progress-heading" className="text-lg font-semibold">
          Batch progress
        </h2>
        <span
          data-testid="progress-connection"
          className="text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          {connection === "live" ? "Live updates" : connection === "polling" ? "Polling fallback" : "Connecting"}
        </span>
      </div>

      {snapshot.error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {snapshot.error}
        </p>
      ) : null}

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium text-slate-500">Job status</dt>
          <dd data-testid="job-status">
            {snapshot.job.status
              ? JOB_STATUS_LABELS[snapshot.job.status]
              : "No batch started"}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">Valid images</dt>
          <dd data-testid="progress-counts">
            {snapshot.setup.validImageCount} of {snapshot.setup.totalImageCount}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">Targets</dt>
          <dd>
            {snapshot.job.counts.succeeded} succeeded · {snapshot.job.counts.failed} failed ·{" "}
            {snapshot.job.counts.queued} queued · {snapshot.job.counts.generating} generating
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">Billing</dt>
          <dd data-testid="cost-labels">
            Lifetime billing (all attempts): reported {snapshot.costs.reportedUsd} USD ·
            estimated {snapshot.costs.estimatedUsd} USD · unknown{" "}
            {snapshot.costs.unknownAttempts}/{snapshot.costs.totalAttempts}
          </dd>
        </div>
      </dl>

      {snapshot.costs.quote ? (
        <p className="text-sm text-slate-600">
          Accepted quote: {snapshot.costs.quote.imageCount} image(s) at{" "}
          {snapshot.costs.quote.unitPriceUsd} USD; base {snapshot.costs.quote.baseUsd} USD,
          worst case {snapshot.costs.quote.worstCaseUsd} USD; indicative starting balance{" "}
          {snapshot.costs.quote.startingBalanceBaseUsd} USD (floor{" "}
          {snapshot.costs.quote.perRequestFloorUsd} USD).
        </p>
      ) : null}

      {snapshot.job.error ? (
        <p role="alert" className="text-sm text-amber-800">
          {snapshot.job.error}
        </p>
      ) : null}

      {snapshot.job.targets.some((target) => target.status === "failed") ? (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-700">Failures</h3>
          <ul className="space-y-1 text-sm text-red-800">
            {snapshot.job.targets
              .filter((target) => target.status === "failed")
              .map((target) => (
                <li key={target.productId}>
                  {target.productId} — {target.error ?? "failed"}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      {active || snapshot.job.status === "stopping" ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={stopBatch}
            disabled={stopping || !active}
            className="rounded bg-rose-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            data-testid="stop-batch"
          >
            {stopping ? "Stopping..." : snapshot.job.status === "stopping" ? "Stop requested" : "Stop batch"}
          </button>
          <span className="text-sm text-slate-600">
            {snapshot.job.status === "stopping"
              ? "Waiting for the in-flight request to settle."
              : "Stops before the next paid request."}
          </span>
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

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Preview</h3>
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
          {snapshot.preview.map((item) => (
            <li key={item.productId} className="space-y-1">
              {item.imageUrl ? (
                <Image
                  src={item.imageUrl}
                  alt={item.name}
                  width={768}
                  height={768}
                  unoptimized
                  className="aspect-square w-full rounded border border-slate-200 bg-slate-100 object-cover"
                />
              ) : (
                <div
                  role="img"
                  aria-label={`Placeholder image for ${item.name}`}
                  className="flex aspect-square items-center justify-center rounded border border-slate-200 bg-slate-100 text-sm font-semibold text-slate-400"
                >
                  {item.name.charAt(0)}
                </div>
              )}
              <p className="text-[10px] text-slate-500">{item.productId}</p>
            </li>
          ))}
        </ul>
      </div>

      <ResumePanel
        jobStatus={snapshot.job.status}
        missingTargets={snapshot.resume.missingTargets}
        retryableTargets={snapshot.resume.retryableTargets}
        terminal={terminal}
      />
    </section>
  );
}