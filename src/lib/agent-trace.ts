import type { AgentWorkerEventMessage } from "./agent-ipc";
import type { AgentDashboardView } from "./agent-dashboard-view";
import type { RunTone } from "./agent-run-display";

/**
 * Client-safe live-trace contract. The server sends snapshots and bounded,
 * already-redacted worker events; the client dedupes by `(runId, seq)` so a
 * reconnect or refresh never duplicates a row.
 */

export const AGENT_STREAM_VERSION = 1 as const;
export const AGENT_TRACE_VERSION = 1 as const;
/** Mirrors the worker's persisted-event cap (`AGENT_WORKER_MAX_EVENTS`). */
export const AGENT_TRACE_MAX_EVENTS = 1_000;

export interface AgentStreamSnapshot {
  readonly version: typeof AGENT_STREAM_VERSION;
  readonly generatedAt: string;
  readonly view: AgentDashboardView;
  readonly corruptRuns: number;
}

export interface AgentTracePayload {
  readonly version: typeof AGENT_TRACE_VERSION;
  readonly runId: string | null;
  readonly events: readonly AgentWorkerEventMessage[];
  readonly truncated: boolean;
  readonly reset: boolean;
}

export interface AgentTraceState {
  readonly runId: string | null;
  readonly events: readonly AgentWorkerEventMessage[];
  readonly truncated: boolean;
}

export const EMPTY_AGENT_TRACE: AgentTraceState = Object.freeze({
  runId: null,
  events: [],
  truncated: false,
});

export interface AgentEventDescription {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: RunTone;
}

export function describeAgentEvent(
  event: AgentWorkerEventMessage,
): AgentEventDescription {
  switch (event.kind) {
    case "agent_start":
      return {
        label: "Agent started",
        detail: "The SDK began the browser run.",
        tone: "neutral",
      };
    case "agent_end":
      return {
        label: "Agent finished",
        detail: "The SDK finished the browser run.",
        tone: "neutral",
      };
    case "turn_start":
      return { label: "Model turn started", detail: null, tone: "neutral" };
    case "turn_end":
      return { label: "Model turn finished", detail: null, tone: "neutral" };
    case "tool_start":
      return {
        label: `Tool started: ${event.toolName ?? "unknown"}`,
        detail: "The browser is executing a tool.",
        tone: "neutral",
      };
    case "tool_end": {
      const name = event.toolName ?? "unknown";
      if (event.isError === true) {
        return {
          label: `Tool failed: ${name}`,
          detail: "The tool reported an error.",
          tone: "danger",
        };
      }
      return {
        label: `Tool finished: ${name}`,
        detail:
          event.imageContent === true
            ? "The result carried image content."
            : null,
        tone: "neutral",
      };
    }
  }
}

export interface AgentTraceSummary {
  /** Browser tool starts; a derived step count, not the SDK's step metric. */
  readonly step: number;
  readonly latestAction: string;
  readonly latestDetail: string | null;
  readonly latestTone: RunTone;
  readonly toolErrors: number;
  readonly imageObserved: boolean;
  readonly eventCount: number;
}

export function summarizeAgentTrace(
  events: readonly AgentWorkerEventMessage[],
): AgentTraceSummary {
  const last = events.length > 0 ? events[events.length - 1] : undefined;
  const described = last ? describeAgentEvent(last) : null;
  return {
    step: events.filter((event) => event.kind === "tool_start").length,
    latestAction: described?.label ?? "No browser actions yet.",
    latestDetail: described?.detail ?? null,
    latestTone: described?.tone ?? "neutral",
    toolErrors: events.filter(
      (event) => event.kind === "tool_end" && event.isError === true,
    ).length,
    imageObserved: events.some((event) => event.imageContent === true),
    eventCount: events.length,
  };
}

/**
 * Merge a trace payload into local state. A reset or a different run replaces
 * the list; otherwise events are deduped by seq, sorted, and capped.
 */
export function mergeAgentTrace(
  current: AgentTraceState,
  payload: AgentTracePayload,
): AgentTraceState {
  if (payload.runId === null) return EMPTY_AGENT_TRACE;
  const base =
    payload.reset || current.runId !== payload.runId ? [] : current.events;
  const bySeq = new Map<number, AgentWorkerEventMessage>();
  for (const event of base) bySeq.set(event.seq, event);
  for (const event of payload.events) {
    if (event.runId !== payload.runId) continue;
    bySeq.set(event.seq, event);
  }
  const events = [...bySeq.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-AGENT_TRACE_MAX_EVENTS);
  return {
    runId: payload.runId,
    events,
    truncated: payload.truncated,
  };
}

/** Deterministic UTC clock label; avoids SSR/client locale hydration drift. */
export function formatTraceTime(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return at;
  return `${new Date(parsed).toISOString().slice(11, 19)}Z`;
}
