import type { AgentRecoveryStatus } from "@/server/agent-manager";

const STATUS_LABELS: Record<AgentRecoveryStatus["status"], string> = {
  reconciled: "Reconciled",
  skipped: "Skipped (no active runs)",
  failed: "Recovery failed",
};

export interface RecoveryPanelProps {
  readonly recovery: AgentRecoveryStatus | null;
}

export function RecoveryPanel({ recovery }: RecoveryPanelProps) {
  if (recovery === null) return null;
  const needsAttention =
    recovery.status === "failed" || recovery.unresolvedCount > 0;
  return (
    <section
      aria-labelledby="agent-recovery-heading"
      data-testid="agent-recovery-panel"
      className={`space-y-3 rounded-lg border p-5 ${
        needsAttention
          ? "border-amber-300 bg-amber-50"
          : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="agent-recovery-heading" className="text-lg font-semibold">
          Startup recovery
        </h2>
        <span
          data-testid="agent-recovery-status"
          className={`text-sm font-medium ${
            needsAttention ? "text-amber-900" : "text-slate-600"
          }`}
        >
          {STATUS_LABELS[recovery.status]}
        </span>
      </div>
      <p className="text-sm text-slate-600">
        Last run at <time dateTime={recovery.finishedAt}>{recovery.finishedAt}</time>.
        Corrupt run records: {recovery.corruptRuns}. Unresolved process groups:{" "}
        {recovery.unresolvedCount}.
      </p>
      {recovery.message ? (
        <p role="alert" className="text-sm text-amber-900">
          {recovery.message}
        </p>
      ) : null}
      {recovery.unresolved.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-amber-900">
            Manual cleanup keeps the paid-operation barrier held.
          </p>
          <ul className="space-y-2 text-sm">
            {recovery.unresolved.map((entry) => (
              <li
                key={entry.runId}
                data-testid="agent-recovery-unresolved"
                className="rounded border border-amber-200 bg-white p-3"
              >
                <p className="font-mono text-xs break-all">{entry.runId}</p>
                <p className="text-slate-700">
                  Outcome: {entry.outcome}
                  {entry.reason ? ` (${entry.reason})` : ""}; lock: {entry.lock}
                </p>
                <p className="text-slate-700">{entry.message}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
