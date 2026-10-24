"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { guardedJsonFetch, readErrorMessage } from "@/app/setup/guard-fetch";
import type { AgentRunLimits } from "@/lib/agent-ipc";
import {
  pickAgentVerificationView,
  type AgentStatusLike,
  type AgentVerificationView,
} from "@/lib/agent-verification-view";
import { formatUsd } from "@/lib/format";
import type { AgentRunRecord } from "@/server/agent-runs";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const POLL_INTERVAL_MS = 1_000;
const POLL_BUDGET_MS = 180_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const GATE_LABELS: Record<AgentVerificationView["gate"]["reason"], string> = {
  verified: "Verified",
  "key-required": "An OpenRouter API key is required",
  "sdk-unavailable": "The installed browser SDK is unavailable",
  "verification-required": "Verification is required before live tasks",
  "model-mismatch": "The saved verification belongs to a different browser model",
  "origin-mismatch": "The saved verification belongs to a different app origin",
  "sdk-mismatch": "The saved verification belongs to a different SDK version",
};

function runStatusLabel(run: AgentRunRecord): string {
  if (run.evaluation.status === "passed") {
    return "The Shop heading check passed.";
  }
  if (run.evaluation.status === "failed") {
    return `The Shop heading check failed: ${run.evaluation.reason ?? "no reason was recorded"}`;
  }
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return `The run ended as ${run.status} before an evaluation was recorded.`;
  }
  return `The verification run is ${run.status}.`;
}

export interface VerifyAgentModelFormProps {
  readonly initial: AgentVerificationView;
  readonly limits: AgentRunLimits;
}

export function VerifyAgentModelForm({
  initial,
  limits,
}: VerifyAgentModelFormProps) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pollRunId, setPollRunId] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { gate, activeRunId, latestVerification } = view;
  const runActive = pollRunId !== null || activeRunId !== null;
  // A stopped poller must stay stopped even while the run is still active;
  // otherwise the effect would silently restart with a fresh budget.
  const polling = runActive && !pollingStopped;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + POLL_BUDGET_MS;
    let failures = 0;

    const readStatus = async (): Promise<AgentStatusLike | null> => {
      const response = await fetch("/api/agent/status", { cache: "no-store" });
      if (!response.ok) return null;
      return (await response.json()) as AgentStatusLike;
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const snapshot = await readStatus();
        if (cancelled) return;
        if (snapshot === null) throw new Error("status unavailable");
        failures = 0;
        setError(null);
        setView(pickAgentVerificationView(snapshot));
        const run =
          pollRunId === null
            ? undefined
            : snapshot.runs.find((candidate) => candidate.runId === pollRunId);
        const settled =
          snapshot.activeRunId === null &&
          (pollRunId === null ||
            (run !== undefined && TERMINAL_RUN_STATUSES.has(run.status)));
        if (settled) {
          // The stamp is written before the supervisor releases its active
          // entry, so one more read makes the final state visible.
          const finalSnapshot = await readStatus();
          if (!cancelled && finalSnapshot !== null) {
            setView(pickAgentVerificationView(finalSnapshot));
          }
          if (!cancelled) {
            setPollRunId(null);
            setBusy(false);
            setMessage(null);
            setError(null);
            router.refresh();
          }
          return;
        }
      } catch {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          setError(
            "Status updates are unavailable. The run may still be active; refresh the page to check.",
          );
          setPollingStopped(true);
          setPollRunId(null);
          setBusy(false);
          return;
        }
      }
      if (Date.now() >= deadline) {
        setError(
          "The run is still active after the polling window. Refresh the page to inspect its result.",
        );
        setPollingStopped(true);
        setPollRunId(null);
        setBusy(false);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [polling, pollRunId, router]);

  async function startVerification() {
    if (!confirmed || busy || runActive) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setPollingStopped(false);
    try {
      const response = await guardedJsonFetch("/api/agent/verify", {
        method: "POST",
        body: { confirmCost: true },
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        setBusy(false);
        return;
      }
      const payload = (await response.json()) as {
        run?: { runId?: unknown };
      };
      const runId =
        typeof payload.run?.runId === "string" ? payload.run.runId : null;
      setConfirmed(false);
      if (runId === null) {
        setError(
          "The verification run started but its ID was missing. Refresh the page to inspect the status.",
        );
        setBusy(false);
        return;
      }
      setMessage(
        "Verification run started. The model must read the Shop heading through the local browser.",
      );
      setPollRunId(runId);
    } catch {
      setError("The verification request could not be sent.");
      setBusy(false);
    }
  }

  const verificationNote =
    gate.verified && gate.verifiedAt
      ? `Verified at ${gate.verifiedAt}.`
      : GATE_LABELS[gate.reason];
  const passedButNotStamped =
    latestVerification?.evaluation.status === "passed" && !gate.verified;

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="verification-state-heading"
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-5"
      >
        <h2 id="verification-state-heading" className="text-lg font-semibold">
          Current model verification
        </h2>
        <p data-testid="verification-state" className="text-sm text-slate-700">
          {verificationNote}
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-slate-500">Browser model</dt>
            <dd className="break-all">{gate.modelId}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Browser SDK</dt>
            <dd>{gate.sdkVersion ?? "Unavailable (run npm install)"}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">App origin</dt>
            <dd className="break-all">{gate.origin}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Screenshot input</dt>
            <dd data-testid="verification-vision">
              {gate.vision === "observed"
                ? "Observed (a tool result carried image content)"
                : "Unverified (no image transport evidence yet)"}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">OpenRouter key</dt>
            <dd>{gate.keyAvailable ? "Available to this server" : "Not available"}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Active run</dt>
            <dd data-testid="verification-active-run">
              {activeRunId ?? "None"}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-slate-600">
          Arbitrary live tasks stay unavailable until the current key, browser model, SDK
          version, and app origin are verified. A text-heading answer proves browser and model
          access only; it does not prove that screenshots reached the vision model.
        </p>
      </section>

      <section
        aria-labelledby="verify-heading"
        className="space-y-4 rounded-lg border border-amber-300 bg-amber-50 p-5"
      >
        <div className="space-y-1">
          <h2 id="verify-heading" className="text-lg font-semibold">
            Verify agent model
          </h2>
          <p
            data-testid="verification-cost-warning"
            className="text-sm text-amber-900"
          >
            Cost warning: this starts one real OpenRouter browser-agent run on your account.
            It is limited to {limits.maxSteps} steps, {Math.round(limits.timeoutMs / 1000)}{" "}
            seconds, and a soft cost limit of {formatUsd(limits.maxCostUsd)}. Usage is an
            SDK-side estimate, not a provider invoice, and a run can overshoot the soft limit
            by one response. It performs only the fixed local <code>/shop</code> heading check;
            no arbitrary instructions are accepted.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm text-amber-950">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || runActive}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-1"
          />
          I understand this verification run may incur OpenRouter charges on my account.
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={startVerification}
            disabled={!confirmed || busy || runActive || !gate.keyAvailable}
            data-testid="verify-agent-model"
            className="rounded bg-amber-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy || polling ? "Verifying..." : "Verify Agent Model"}
          </button>
          {!gate.keyAvailable ? (
            <span className="text-sm text-amber-900">
              Add and validate an OpenRouter key in Setup first.
            </span>
          ) : polling ? (
            <span className="text-sm text-amber-900">
              A run is active; the result appears automatically.
            </span>
          ) : runActive ? (
            <span className="text-sm text-amber-900">
              Status updates stopped; refresh the page to resume watching the active run.
            </span>
          ) : null}
        </div>
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

      {latestVerification ? (
        <section
          aria-labelledby="verification-run-heading"
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-5"
        >
          <h2 id="verification-run-heading" className="text-lg font-semibold">
            Last verification run
          </h2>
          <p data-testid="verification-result" className="text-sm text-slate-700">
            {runStatusLabel(latestVerification)}
            {passedButNotStamped
              ? " The heading check passed, but the current key, model, SDK, or origin no longer matches that run, so no verification stamp was written."
              : ""}
          </p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-slate-500">Execution</dt>
              <dd>
                {latestVerification.status}
                {latestVerification.stopReason
                  ? ` (SDK: ${latestVerification.stopReason})`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Steps and duration</dt>
              <dd>
                {latestVerification.steps ?? "unknown"} steps ·{" "}
                {latestVerification.durationMs === null
                  ? "unknown duration"
                  : `${Math.round(latestVerification.durationMs / 1000)} s`}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Estimated cost</dt>
              <dd>
                {latestVerification.usage?.estimatedCostUsd === null ||
                latestVerification.usage === null
                  ? "unknown"
                  : formatUsd(latestVerification.usage.estimatedCostUsd)}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Vision evidence</dt>
              <dd>
                {latestVerification.vision === "observed"
                  ? "Observed"
                  : "Unverified"}
              </dd>
            </div>
          </dl>
          {latestVerification.outputText ? (
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-700">Answer</h3>
              <pre className="overflow-x-auto rounded bg-slate-100 p-3 text-xs text-slate-800">
                {latestVerification.outputText}
              </pre>
            </div>
          ) : null}
          {latestVerification.error ? (
            <p role="alert" className="text-sm text-red-700">
              {latestVerification.error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
