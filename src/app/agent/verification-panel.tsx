"use client";

import type { AgentDashboardView } from "@/lib/agent-dashboard-view";
import type { AgentRunLimits } from "@/lib/agent-ipc";
import {
  describeExecutionStatus,
  describeStopReason,
  formatDuration,
  formatEstimatedCost,
} from "@/lib/agent-run-display";
import { formatUsd } from "@/lib/format";
import type { AgentRunRecord } from "@/server/agent-runs";
import type { DashboardAction, DashboardFeedback } from "./agent-dashboard";

const GATE_LABELS: Record<AgentDashboardView["gate"]["reason"], string> = {
  verified: "Verified",
  "key-required": "An OpenRouter API key is required",
  "sdk-unavailable": "The installed browser SDK is unavailable",
  "verification-required": "Verification is required before live tasks",
  "model-mismatch": "The saved verification belongs to a different browser model",
  "origin-mismatch": "The saved verification belongs to a different app origin",
  "sdk-mismatch": "The saved verification belongs to a different SDK version",
};

function verificationResultLabel(run: AgentRunRecord): string {
  if (run.evaluation.status === "passed") {
    return "The Shop heading check passed.";
  }
  if (run.evaluation.status === "failed") {
    return `The Shop heading check failed: ${run.evaluation.reason ?? "no reason was recorded"}`;
  }
  if (run.status === "completed" || run.status === "failed") {
    return `The run ended as ${run.status} before an evaluation was recorded.`;
  }
  return `The verification run is ${run.status}.`;
}

export interface VerificationPanelProps {
  readonly view: AgentDashboardView;
  readonly limits: AgentRunLimits;
  readonly runActive: boolean;
  readonly polling: boolean;
  readonly busy: DashboardAction | null;
  readonly feedback: DashboardFeedback | null;
  readonly confirmed: boolean;
  readonly onConfirmedChange: (confirmed: boolean) => void;
  readonly onVerify: () => void;
}

export function VerificationPanel({
  view,
  limits,
  runActive,
  polling,
  busy,
  feedback,
  confirmed,
  onConfirmedChange,
  onVerify,
}: VerificationPanelProps) {
  const { gate, activeRunId, latestVerification } = view;
  const verificationRunning =
    polling && view.activeRun?.kind === "verification";
  const verificationFeedback =
    feedback?.scope === "verification" ? feedback : null;

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
            <dd>
              {gate.keyAvailable ? "Available to this server" : "Not available"}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Active run</dt>
            <dd data-testid="verification-active-run">
              {activeRunId ?? "None"}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-slate-600">
          Arbitrary live tasks stay unavailable until the current key, browser
          model, SDK version, and app origin are verified. A text-heading answer
          proves browser and model access only; it does not prove that
          screenshots reached the vision model.
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
            Cost warning: this starts one real OpenRouter browser-agent run on
            your account. It is limited to {limits.maxSteps} steps,{" "}
            {Math.round(limits.timeoutMs / 1000)} seconds, and a soft cost limit
            of {formatUsd(limits.maxCostUsd)}. Usage is an SDK-side estimate, not
            a provider invoice, and a run can overshoot the soft limit by one
            response. It performs only the fixed local <code>/shop</code>{" "}
            heading check; no arbitrary instructions are accepted.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm text-amber-950">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy !== null || runActive}
            onChange={(event) => onConfirmedChange(event.target.checked)}
            className="mt-1"
          />
          I understand this verification run may incur OpenRouter charges on my
          account.
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onVerify}
            disabled={!confirmed || busy !== null || runActive || !gate.keyAvailable}
            data-testid="verify-agent-model"
            className="rounded bg-amber-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === "verify" || verificationRunning
              ? "Verifying..."
              : "Verify Agent Model"}
          </button>
          {!gate.keyAvailable ? (
            <span className="text-sm text-amber-900">
              Add and validate an OpenRouter key in Setup first.
            </span>
          ) : verificationRunning ? (
            <span className="text-sm text-amber-900">
              A verification run is active; the result appears automatically.
            </span>
          ) : runActive && polling ? (
            <span className="text-sm text-amber-900">
              Another agent run is active; verification waits for it.
            </span>
          ) : runActive ? (
            <span className="text-sm text-amber-900">
              Status updates stopped; refresh the page to resume watching the
              active run.
            </span>
          ) : null}
        </div>
        {verificationFeedback ? (
          <p
            role={verificationFeedback.tone === "error" ? "alert" : "status"}
            className={
              verificationFeedback.tone === "error"
                ? "text-sm text-red-700"
                : "text-sm text-emerald-800"
            }
          >
            {verificationFeedback.text}
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
            {verificationResultLabel(latestVerification)}
            {passedButNotStamped
              ? " The heading check passed, but the current key, model, SDK, or origin no longer matches that run, so no verification stamp was written."
              : ""}
          </p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-slate-500">Execution</dt>
              <dd>
                {describeExecutionStatus(latestVerification).label} ·{" "}
                {describeStopReason(latestVerification.stopReason)}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Steps and duration</dt>
              <dd>
                {latestVerification.steps ?? "unknown"} steps ·{" "}
                {formatDuration(latestVerification.durationMs)}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Estimated cost</dt>
              <dd>{formatEstimatedCost(latestVerification.usage)}</dd>
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
