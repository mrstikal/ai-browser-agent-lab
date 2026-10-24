"use client";

import {
  AGENT_TRACE_MAX_EVENTS,
  describeAgentEvent,
  formatTraceTime,
  summarizeAgentTrace,
  type AgentTraceState,
} from "@/lib/agent-trace";
import type { RunTone } from "@/lib/agent-run-display";

const TONE_TEXT: Record<RunTone, string> = {
  neutral: "text-slate-800",
  success: "text-emerald-800",
  warning: "text-amber-900",
  danger: "text-red-800",
};

export type AgentStreamConnection = "connecting" | "live" | "fallback";

const CONNECTION_LABEL: Record<AgentStreamConnection, string> = {
  connecting: "Connecting…",
  live: "Live",
  fallback: "Reconnecting (status polling)",
};

export interface TracePanelProps {
  readonly trace: AgentTraceState;
  readonly connection: AgentStreamConnection;
  readonly pollingStopped: boolean;
  readonly error: string | null;
}

export function TracePanel({
  trace,
  connection,
  pollingStopped,
  error,
}: TracePanelProps) {
  const summary = summarizeAgentTrace(trace.events);

  return (
    <section
      aria-labelledby="agent-trace-heading"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="agent-trace-heading" className="text-lg font-semibold">
          Live trace
        </h2>
        <span
          data-testid="agent-trace-connection"
          className={
            connection === "live"
              ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-900"
              : connection === "fallback"
                ? "rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900"
                : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
          }
        >
          {CONNECTION_LABEL[connection]}
        </span>
      </div>

      <p className="text-sm text-slate-600">
        The visible Chromium window is the primary visualization. This trace is
        the persisted chronological event list for the current or last task
        run, replayed after a refresh or reconnect.
      </p>

      {connection === "fallback" ? (
        <p className="text-sm text-amber-900">
          {pollingStopped
            ? "The live stream is reconnecting and status polling has stopped. Refresh the page to inspect the run; the trace resumes from the last persisted event."
            : "The live stream is reconnecting. Status polling keeps the run panel current; the trace resumes from the last persisted event."}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid="agent-trace-error"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      {trace.runId === null ? (
        error ? null : (
          <p data-testid="agent-trace-empty" className="text-sm text-slate-600">
            No task trace yet. The first browser action appears here after a
            task starts.
          </p>
        )
      ) : (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-medium text-slate-500">Tool steps</dt>
              <dd data-testid="agent-trace-step">{summary.step}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Events</dt>
              <dd data-testid="agent-trace-count">{summary.eventCount}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Tool errors</dt>
              <dd data-testid="agent-trace-errors">{summary.toolErrors}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="font-medium text-slate-500">Latest action</dt>
              <dd
                data-testid="agent-trace-latest-action"
                className={TONE_TEXT[summary.latestTone]}
              >
                {summary.latestAction}
                {summary.latestDetail ? (
                  <span className="block text-xs text-slate-500">
                    {summary.latestDetail}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Image content</dt>
              <dd data-testid="agent-trace-image">
                {summary.imageObserved ? "Observed in trace" : "Not observed"}
              </dd>
            </div>
          </dl>

          {trace.truncated ? (
            <p className="text-sm text-amber-900">
              The persisted trace has an incomplete final line (a crash or an
              append in progress); that line is not shown.
            </p>
          ) : null}
          {trace.events.length >= AGENT_TRACE_MAX_EVENTS ? (
            <p className="text-sm text-slate-600">
              Showing the most recent {AGENT_TRACE_MAX_EVENTS} events.
            </p>
          ) : null}

          <ol
            aria-label="Chronological agent trace"
            data-testid="agent-trace-events"
            className="max-h-96 space-y-1 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-3"
          >
            {trace.events.map((event) => {
              const description = describeAgentEvent(event);
              return (
                <li
                  key={event.seq}
                  data-testid="agent-trace-event"
                  data-seq={event.seq}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded px-2 py-1 text-sm odd:bg-white"
                >
                  <span className="font-mono text-xs text-slate-500">
                    #{event.seq}
                  </span>
                  <span className="font-mono text-xs text-slate-500">
                    {formatTraceTime(event.at)}
                  </span>
                  <span className={TONE_TEXT[description.tone]}>
                    {description.label}
                  </span>
                  {event.imageContent === true ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">
                      image
                    </span>
                  ) : null}
                  {event.isError === true ? (
                    <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                      error
                    </span>
                  ) : null}
                  {description.detail ? (
                    <span className="basis-full text-xs text-slate-500">
                      {description.detail}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <p className="text-xs text-slate-500">
            Trace rows contain action names, timestamps, and error/image flags
            only. Prompts, request headers, and key material are never stored
            here.
          </p>
        </>
      )}
    </section>
  );
}
