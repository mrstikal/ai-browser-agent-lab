"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { guardedJsonFetch } from "@/app/setup/guard-fetch";
import {
  pickAgentDashboardView,
  type AgentDashboardView,
  type AgentStatusLike,
} from "@/lib/agent-dashboard-view";
import type { AgentRunLimits } from "@/lib/agent-ipc";
import type { AgentRunRecord } from "@/server/agent-runs";
import { TaskPanel } from "./task-panel";
import { VerificationPanel } from "./verification-panel";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const POLL_INTERVAL_MS = 1_000;
/**
 * The supervisor settles a limit-bound run only after the SDK timeout, the
 * watchdog margin, the cancel grace, and a verified process-group scan. The
 * poll budget must outlive that, or a timed-out run would freeze the panel.
 */
const POLL_SETTLE_SLACK_MS = 60_000;
const DEFAULT_POLL_BUDGET_MS = 240_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

export type DashboardAction = "verify" | "task" | "cancel";

function applyReturnedRun(
  current: AgentDashboardView,
  run: AgentRunRecord,
): AgentDashboardView {
  const isActive =
    run.status === "running" ||
    run.status === "cancelling" ||
    run.status === "hung";
  return {
    ...current,
    activeRunId: isActive ? run.runId : current.activeRunId,
    activeRun: isActive ? run : current.activeRun,
    latestTask: run.kind === "task" ? run : current.latestTask,
    latestVerification:
      run.kind === "verification" ? run : current.latestVerification,
  };
}

async function readMutationFailure(
  response: Response,
): Promise<{ message: string; run: AgentRunRecord | null }> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown };
      run?: AgentRunRecord;
    };
    const message =
      typeof payload.error?.message === "string"
        ? payload.error.message
        : `The request failed (${response.status}).`;
    const run =
      payload.run !== undefined && typeof payload.run.runId === "string"
        ? payload.run
        : null;
    return { message, run };
  } catch {
    return { message: `The request failed (${response.status}).`, run: null };
  }
}

export interface DashboardFeedback {
  readonly scope: "verification" | "task";
  readonly tone: "status" | "error";
  readonly text: string;
}

export interface TaskLimitsCaps {
  readonly maxSteps: number;
  readonly maxTimeoutMs: number;
  readonly maxCostUsd: number;
}

export interface AgentDashboardProps {
  readonly initial: AgentDashboardView;
  readonly verificationLimits: AgentRunLimits;
  readonly taskDefaults: AgentRunLimits;
  readonly taskCaps: TaskLimitsCaps;
  readonly maxTaskChars: number;
}

export function AgentDashboard({
  initial,
  verificationLimits,
  taskDefaults,
  taskCaps,
  maxTaskChars,
}: AgentDashboardProps) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<DashboardAction | null>(null);
  const [pollRunId, setPollRunId] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<DashboardFeedback | null>(null);
  const [verificationConfirmed, setVerificationConfirmed] = useState(false);
  // React state is asynchronous, so a fast double click would otherwise send
  // two guarded mutations; the server refuses the duplicate, but the ref keeps
  // the client from producing a confusing second error.
  const requestInFlight = useRef(false);

  const runActive = pollRunId !== null || view.activeRunId !== null;
  // A stopped poller must stay stopped even while the run is still active;
  // otherwise the effect would silently restart with a fresh budget.
  const polling = runActive && !pollingStopped;
  const activeRunTimeoutMs = view.activeRun?.limits.timeoutMs ?? null;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline =
      Date.now() +
      (activeRunTimeoutMs === null
        ? DEFAULT_POLL_BUDGET_MS
        : activeRunTimeoutMs + POLL_SETTLE_SLACK_MS);
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
        setPollError(null);
        setView(pickAgentDashboardView(snapshot));
        const run =
          pollRunId === null
            ? undefined
            : snapshot.runs.find((candidate) => candidate.runId === pollRunId);
        const settled =
          snapshot.activeRunId === null &&
          (pollRunId === null ||
            (run !== undefined && TERMINAL_RUN_STATUSES.has(run.status)));
        if (settled) {
          // The verification stamp is written before the supervisor releases
          // its active entry, so one more read makes the final state visible.
          const finalSnapshot = await readStatus();
          if (!cancelled && finalSnapshot !== null) {
            setView(pickAgentDashboardView(finalSnapshot));
          }
          if (!cancelled) {
            setPollRunId(null);
            setPollingStopped(false);
            setBusy(null);
            setFeedback(null);
            setPollError(null);
            router.refresh();
          }
          return;
        }
      } catch {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          setPollError(
            "Status updates are unavailable. The run may still be active; refresh the page to check.",
          );
          setPollingStopped(true);
          setPollRunId(null);
          setBusy(null);
          return;
        }
      }
      if (Date.now() >= deadline) {
        setPollError(
          "The run is still active after the polling window. Refresh the page to inspect its result.",
        );
        setPollingStopped(true);
        setPollRunId(null);
        setBusy(null);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [polling, pollRunId, activeRunTimeoutMs, router]);

  async function startVerification(): Promise<void> {
    if (requestInFlight.current || busy !== null || runActive) return;
    requestInFlight.current = true;
    setBusy("verify");
    setFeedback(null);
    setPollError(null);
    setPollingStopped(false);
    try {
      const response = await guardedJsonFetch("/api/agent/verify", {
        method: "POST",
        body: { confirmCost: true },
      });
      if (!response.ok) {
        const failure = await readMutationFailure(response);
        setFeedback({
          scope: "verification",
          tone: "error",
          text: failure.message,
        });
        const failedRun = failure.run;
        if (failedRun !== null) {
          setView((current) => applyReturnedRun(current, failedRun));
        }
        return;
      }
      const payload = (await response.json()) as { run?: AgentRunRecord };
      const run = payload.run;
      const runId = typeof run?.runId === "string" ? run.runId : null;
      if (run === undefined || runId === null) {
        setFeedback({
          scope: "verification",
          tone: "error",
          text: "The verification run started but its record was missing. Refresh the page to inspect the status.",
        });
        return;
      }
      setView((current) => applyReturnedRun(current, run));
      setVerificationConfirmed(false);
      setFeedback({
        scope: "verification",
        tone: "status",
        text: "Verification run started. The model must read the Shop heading through the local browser.",
      });
      setPollRunId(runId);
    } catch {
      setFeedback({
        scope: "verification",
        tone: "error",
        text: "The verification request could not be sent.",
      });
    } finally {
      requestInFlight.current = false;
      setBusy(null);
    }
  }

  async function startTask(task: string): Promise<boolean> {
    if (requestInFlight.current || busy !== null || runActive) return false;
    requestInFlight.current = true;
    setBusy("task");
    setFeedback(null);
    setPollError(null);
    setPollingStopped(false);
    try {
      const response = await guardedJsonFetch("/api/agent/runs", {
        method: "POST",
        body: { task },
      });
      if (!response.ok) {
        const failure = await readMutationFailure(response);
        setFeedback({
          scope: "task",
          tone: "error",
          text: failure.message,
        });
        const failedRun = failure.run;
        if (failedRun !== null) {
          setView((current) => applyReturnedRun(current, failedRun));
        }
        return false;
      }
      const payload = (await response.json()) as { run?: AgentRunRecord };
      const run = payload.run;
      const runId = typeof run?.runId === "string" ? run.runId : null;
      if (run === undefined || runId === null) {
        setFeedback({
          scope: "task",
          tone: "error",
          text: "The task run started but its record was missing. Refresh the page to inspect the status.",
        });
        return false;
      }
      setView((current) => applyReturnedRun(current, run));
      setFeedback({
        scope: "task",
        tone: "status",
        text: "Task run started. The supervisor is launching the local browser.",
      });
      setPollRunId(runId);
      return true;
    } catch {
      setFeedback({
        scope: "task",
        tone: "error",
        text: "The task request could not be sent.",
      });
      return false;
    } finally {
      requestInFlight.current = false;
      setBusy(null);
    }
  }

  async function cancelRun(runId: string): Promise<void> {
    if (requestInFlight.current || busy !== null) return;
    requestInFlight.current = true;
    setBusy("cancel");
    setFeedback(null);
    setPollError(null);
    try {
      const response = await guardedJsonFetch("/api/agent/runs/cancel", {
        method: "POST",
        body: { runId },
      });
      if (!response.ok) {
        setFeedback({
          scope: "task",
          tone: "error",
          text: (await readMutationFailure(response)).message,
        });
        return;
      }
      setFeedback({
        scope: "task",
        tone: "status",
        text: "Cancellation requested. The run keeps its paid lock until the worker is proven gone.",
      });
    } catch {
      setFeedback({
        scope: "task",
        tone: "error",
        text: "The cancel request could not be sent.",
      });
    } finally {
      requestInFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {pollError ? (
        <p
          role="alert"
          data-testid="agent-poll-error"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800"
        >
          {pollError}
        </p>
      ) : null}
      <VerificationPanel
        view={view}
        limits={verificationLimits}
        runActive={runActive}
        polling={polling}
        busy={busy}
        feedback={feedback}
        confirmed={verificationConfirmed}
        onConfirmedChange={setVerificationConfirmed}
        onVerify={() => void startVerification()}
      />
      <TaskPanel
        view={view}
        defaults={taskDefaults}
        caps={taskCaps}
        maxTaskChars={maxTaskChars}
        runActive={runActive}
        polling={polling}
        busy={busy}
        feedback={feedback}
        onRun={startTask}
        onCancel={(runId) => void cancelRun(runId)}
      />
    </div>
  );
}
