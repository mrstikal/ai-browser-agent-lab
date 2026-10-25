"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { guardedJsonFetch } from "@/app/setup/guard-fetch";
import {
  pickAgentDashboardView,
  type AgentDashboardView,
  type AgentStatusLike,
} from "@/lib/agent-dashboard-view";
import { mergeAgentRunSummary } from "@/lib/agent-history";
import type { AgentRunLimits } from "@/lib/agent-ipc";
import type { AgentTaskStartRequest } from "@/lib/agent-tasks";
import {
  AGENT_STREAM_VERSION,
  AGENT_TRACE_VERSION,
  EMPTY_AGENT_TRACE,
  mergeAgentTrace,
  type AgentStreamSnapshot,
  type AgentTracePayload,
  type AgentTraceState,
} from "@/lib/agent-trace";
import type { AgentRunRecord } from "@/server/agent-runs";
import { HistoryPanel } from "./history-panel";
import { TaskPanel } from "./task-panel";
import { TracePanel, type AgentStreamConnection } from "./trace-panel";
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
  const latest =
    run.kind === "task" ? current.latestTask : current.latestVerification;
  // A terminal SSE snapshot can arrive before the mutation response. Never
  // resurrect that run from the stale running record in the response, and
  // never reactivate a run that a newer same-kind run has already superseded.
  const superseded =
    latest !== null &&
    latest.runId !== run.runId &&
    latest.startedAt > run.startedAt;
  if (
    isActive &&
    (superseded ||
      (latest?.runId === run.runId &&
        TERMINAL_RUN_STATUSES.has(latest.status)))
  ) {
    const clearsActive = current.activeRunId === run.runId;
    return {
      ...current,
      activeRunId: clearsActive ? null : current.activeRunId,
      activeRun: clearsActive ? null : current.activeRun,
    };
  }
  const clearsActive = !isActive && current.activeRunId === run.runId;
  const next: AgentDashboardView = {
    ...current,
    activeRunId: isActive
      ? run.runId
      : clearsActive
        ? null
        : current.activeRunId,
    activeRun: isActive ? run : clearsActive ? null : current.activeRun,
    history: mergeAgentRunSummary(current.history, run),
  };
  return run.kind === "task"
    ? { ...next, latestTask: run }
    : { ...next, latestVerification: run };
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
      payload.run != null && typeof payload.run.runId === "string"
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
  readonly initialTrace: AgentTraceState;
  readonly initialTraceError: string | null;
  readonly initialCorruptRuns: number;
  readonly verificationLimits: AgentRunLimits;
  readonly taskDefaults: AgentRunLimits;
  readonly taskCaps: TaskLimitsCaps;
  readonly maxTaskChars: number;
}

export function AgentDashboard({
  initial,
  initialTrace,
  initialTraceError,
  initialCorruptRuns,
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
  const [corruptRuns, setCorruptRuns] = useState(initialCorruptRuns);
  const [feedback, setFeedback] = useState<DashboardFeedback | null>(null);
  const [verificationConfirmed, setVerificationConfirmed] = useState(false);
  const [connection, setConnection] =
    useState<AgentStreamConnection>("connecting");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [trace, setTrace] = useState<AgentTraceState>(initialTrace);
  const [traceError, setTraceError] = useState<string | null>(
    initialTraceError,
  );
  const [streamError, setStreamError] = useState<string | null>(null);
  // React state is asynchronous, so a fast double click would otherwise send
  // two guarded mutations; the server refuses the duplicate, but the ref keeps
  // the client from producing a confusing second error.
  const requestInFlight = useRef(false);
  const pollRunIdRef = useRef<string | null>(null);
  // The started-at of the polled run, not the response time: a snapshot that
  // predates the run's own start cannot know it yet and must not clear it.
  const pollRunStartedAtRef = useRef<string | null>(null);
  // React state is asynchronous; this ref holds the latest applied view so a
  // mutation response can decide synchronously whether its run is still active.
  const viewRef = useRef(initial);
  // The SSE handlers run outside React's render cycle. This ref lets an
  // in-flight status poll stop before it overwrites a newer live snapshot.
  const connectionRef = useRef<AgentStreamConnection>("connecting");

  const runActive = pollRunId !== null || view.activeRunId !== null;
  // A stopped poller must stay stopped even while the run is still active;
  // otherwise the effect would silently restart with a fresh budget.
  const polling = runActive && !pollingStopped;
  const activeRunTimeoutMs = view.activeRun?.limits.timeoutMs ?? null;
  // A run that falls out of the bounded history can no longer be selected;
  // treat the selection as cleared without a state-setting effect.
  const selectedHistoryRunId =
    selectedRunId !== null &&
    view.history.some((run) => run.runId === selectedRunId)
      ? selectedRunId
      : null;

  const applyView = useCallback((next: AgentDashboardView): void => {
    viewRef.current = next;
    setView(next);
  }, []);

  /**
   * Selecting a run immediately shows an empty trace for that run; the saved
   * trace endpoint and the SSE stream then fill it. Selecting `null` follows
   * the active/latest task again.
   */
  const selectHistoryRun = useCallback(
    (runId: string | null, resetConnection = false): void => {
      setSelectedRunId(runId);
      setTraceError(null);
      setStreamError(null);
      // Selecting a saved run reopens the stream; following the latest trace
      // also reopens it when a run was selected. Starting a run while already
      // following the latest leaves the stream target unchanged.
      if (runId !== null || resetConnection) {
        connectionRef.current = "connecting";
        setConnection("connecting");
      }
      setTrace(
        runId === null
          ? EMPTY_AGENT_TRACE
          : { runId, events: [], truncated: false },
      );
    },
    [],
  );

  const clearPollState = useCallback((): void => {
    pollRunIdRef.current = null;
    pollRunStartedAtRef.current = null;
    setPollRunId(null);
    setPollingStopped(false);
    setBusy(null);
    setFeedback(null);
    setPollError(null);
    router.refresh();
  }, [router]);

  const finishSettledPoll = useCallback(
    (nextView: AgentDashboardView, generatedAt: string): void => {
      const runId = pollRunIdRef.current;
      if (runId === null) return;
      if (nextView.activeRunId !== null) {
        // Only one run can be active. If a different run superseded ours, the
        // polled run is no longer the one this panel should wait for.
        if (nextView.activeRunId !== runId) clearPollState();
        return;
      }
      const candidate =
        nextView.latestTask?.runId === runId
          ? nextView.latestTask
          : nextView.latestVerification?.runId === runId
            ? nextView.latestVerification
            : null;
      if (candidate !== null) {
        if (TERMINAL_RUN_STATUSES.has(candidate.status)) clearPollState();
        return;
      }
      // No active run and our run is not the latest of its kind: it cannot
      // still be running under the one-active-run invariant. Ignore a snapshot
      // generated before the run started, which cannot know the run yet.
      const runStartedAt = pollRunStartedAtRef.current;
      const runStartedAtMs =
        runStartedAt === null ? Number.NaN : Date.parse(runStartedAt);
      const generatedAtMs = Date.parse(generatedAt);
      if (
        !Number.isFinite(runStartedAtMs) ||
        !Number.isFinite(generatedAtMs) ||
        generatedAtMs >= runStartedAtMs
      ) {
        clearPollState();
      }
    },
    [clearPollState],
  );

  // Live updates come from the same-origin SSE stream; the polling effect is
  // only a fallback while the stream is connecting or reconnecting. Changing
  // the selected run reopens the stream so its trace cursor starts cleanly.
  useEffect(() => {
    let disposed = false;
    const source = new EventSource(
      selectedHistoryRunId === null
        ? "/api/agent/stream"
        : `/api/agent/stream?run=${encodeURIComponent(selectedHistoryRunId)}`,
    );

    source.addEventListener("open", () => {
      if (disposed) return;
      connectionRef.current = "live";
      setConnection("live");
      setStreamError(null);
      setPollError(null);
      setPollingStopped(false);
    });
    source.addEventListener("snapshot", (event) => {
      if (disposed) return;
      connectionRef.current = "live";
      setConnection("live");
      setStreamError(null);
      setPollError(null);
      setPollingStopped(false);
      try {
        const payload = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as AgentStreamSnapshot;
        if (payload.version !== AGENT_STREAM_VERSION) return;
        applyView(payload.view);
        setCorruptRuns(payload.corruptRuns);
        finishSettledPoll(payload.view, payload.generatedAt);
      } catch {
        // Ignore malformed snapshots; the next tick or the fallback recovers.
      }
    });
    source.addEventListener("trace", (event) => {
      if (disposed) return;
      try {
        const payload = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as AgentTracePayload;
        if (payload.version !== AGENT_TRACE_VERSION) return;
        setTraceError(null);
        setTrace((current) => mergeAgentTrace(current, payload));
      } catch {
        // Ignore malformed trace batches; the next batch recovers.
      }
    });
    source.addEventListener("stream-error", (event) => {
      if (disposed) return;
      let code: unknown;
      try {
        code = (
          JSON.parse((event as MessageEvent<string>).data) as {
            code?: unknown;
          }
        ).code;
      } catch {
        code = undefined;
      }
      if (code === "trace-unreadable") {
        setTraceError(
          "The saved trace is unreadable; the run itself is unaffected.",
        );
        return;
      }
      setStreamError(
        code === "state-unreadable"
          ? "Saved agent state is unreadable. The stream keeps retrying."
          : "Live agent updates are temporarily unavailable.",
      );
    });
    source.addEventListener("error", () => {
      if (disposed) return;
      connectionRef.current = "fallback";
      setConnection("fallback");
    });

    return () => {
      disposed = true;
      source.close();
    };
  }, [applyView, finishSettledPoll, selectedHistoryRunId]);

  // A selected historical run loads immediately even while the SSE stream is
  // connecting. Merging without reset keeps any newer live events already
  // received for the same run.
  useEffect(() => {
    if (selectedHistoryRunId === null) return;
    const controller = new AbortController();
    const requestedRunId = selectedHistoryRunId;
    void (async () => {
      try {
        const response = await fetch(
          `/api/agent/runs/${encodeURIComponent(requestedRunId)}/trace`,
          { cache: "no-store", signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setTraceError(
            response.status === 404
              ? "The selected run is no longer available in saved history."
              : "The saved trace for the selected run is unreadable.",
          );
          return;
        }
        const payload = (await response.json()) as AgentTracePayload;
        if (controller.signal.aborted) return;
        if (payload.version !== AGENT_TRACE_VERSION) return;
        setTraceError(null);
        setTrace((current) =>
          mergeAgentTrace(current, { ...payload, reset: false }),
        );
      } catch {
        if (!controller.signal.aborted) {
          setTraceError(
            "The saved trace for the selected run could not be loaded.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [selectedHistoryRunId]);

  useEffect(() => {
    if (!polling || connection === "live") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const deadline =
      Date.now() +
      (activeRunTimeoutMs === null
        ? DEFAULT_POLL_BUDGET_MS
        : activeRunTimeoutMs + POLL_SETTLE_SLACK_MS);
    let failures = 0;

    const readStatus = async (): Promise<AgentStatusLike | null> => {
      const response = await fetch("/api/agent/status", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as AgentStatusLike;
    };

    // Read through a function so TypeScript does not carry an earlier
    // non-live narrowing across the awaited request.
    const streamIsLive = (): boolean => connectionRef.current === "live";

    const tick = async () => {
      if (cancelled) return;
      try {
        const snapshot = await readStatus();
        if (cancelled || streamIsLive()) return;
        if (snapshot === null) throw new Error("status unavailable");
        failures = 0;
        setPollError(null);
        applyView(pickAgentDashboardView(snapshot));
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
          if (cancelled || streamIsLive()) return;
          if (finalSnapshot !== null) {
            applyView(pickAgentDashboardView(finalSnapshot));
          }
          clearPollState();
          return;
        }
      } catch {
        if (cancelled || streamIsLive()) return;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          setPollError(
            "Status updates are unavailable. The run may still be active; refresh the page to check.",
          );
          setPollingStopped(true);
          pollRunIdRef.current = null;
          pollRunStartedAtRef.current = null;
          setPollRunId(null);
          setBusy(null);
          return;
        }
      }
      if (cancelled || streamIsLive()) return;
      if (Date.now() >= deadline) {
        setPollError(
          "The run is still active after the polling window. Refresh the page to inspect its result.",
        );
        setPollingStopped(true);
        pollRunIdRef.current = null;
        pollRunStartedAtRef.current = null;
        setPollRunId(null);
        setBusy(null);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    polling,
    connection,
    pollRunId,
    activeRunTimeoutMs,
    applyView,
    clearPollState,
  ]);

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
          selectHistoryRun(null);
          applyView(applyReturnedRun(viewRef.current, failedRun));
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
      selectHistoryRun(null);
      applyView(applyReturnedRun(viewRef.current, run));
      setVerificationConfirmed(false);
      setFeedback({
        scope: "verification",
        tone: "status",
        text: "Verification run started. The model must read the Shop heading through the local browser.",
      });
      if (viewRef.current.activeRunId === runId) {
        pollRunIdRef.current = runId;
        pollRunStartedAtRef.current = run.startedAt;
        setPollRunId(runId);
      } else {
        setFeedback(null);
      }
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

  async function startTask(request: AgentTaskStartRequest): Promise<boolean> {
    if (requestInFlight.current || busy !== null || runActive) return false;
    requestInFlight.current = true;
    setBusy("task");
    setFeedback(null);
    setPollError(null);
    setPollingStopped(false);
    try {
      const response = await guardedJsonFetch("/api/agent/runs", {
        method: "POST",
        body:
          "presetId" in request
            ? { presetId: request.presetId }
            : { task: request.task },
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
          selectHistoryRun(null);
          applyView(applyReturnedRun(viewRef.current, failedRun));
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
      selectHistoryRun(null);
      applyView(applyReturnedRun(viewRef.current, run));
      setFeedback({
        scope: "task",
        tone: "status",
        text:
          "presetId" in request
            ? "Preset task run started. The supervisor is launching the local browser."
            : "Task run started. The supervisor is launching the local browser.",
      });
      if (viewRef.current.activeRunId === runId) {
        pollRunIdRef.current = runId;
        pollRunStartedAtRef.current = run.startedAt;
        setPollRunId(runId);
      } else {
        setFeedback(null);
      }
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
      {pollError || streamError ? (
        <p
          role="alert"
          data-testid="agent-poll-error"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800"
        >
          {pollError ?? streamError}
        </p>
      ) : null}
      {corruptRuns > 0 ? (
        <p
          role="alert"
          data-testid="agent-corrupt-runs"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {corruptRuns} saved agent run{" "}
          {corruptRuns === 1 ? "record is" : "records are"} unreadable and{" "}
          {corruptRuns === 1 ? "is" : "are"} hidden. Inspect{" "}
          <code>data/agent-runs</code>.
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
      <HistoryPanel
        history={view.history}
        selectedRunId={selectedHistoryRunId}
        onSelect={(runId) => selectHistoryRun(runId, runId === null)}
      />
      <TracePanel
        trace={trace}
        connection={connection}
        pollingStopped={pollingStopped}
        error={traceError}
        selectedRunId={selectedHistoryRunId}
      />
    </div>
  );
}
