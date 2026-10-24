import {
  AGENT_TRACE_MAX_EVENTS,
  type AgentTraceState,
} from "../lib/agent-trace";
import { loadAgentEvents } from "./agent-runs";
import type { Storage } from "./storage";

/**
 * Read-only persisted trace for one run. Events were bounded and redacted by
 * the worker before they were written, so no prompt text, headers, or key
 * material can appear here.
 */
export async function loadAgentTraceView(
  storage: Storage,
  runId: string,
): Promise<AgentTraceState> {
  const log = await loadAgentEvents(storage, runId);
  return {
    runId,
    events: log.events.slice(-AGENT_TRACE_MAX_EVENTS),
    truncated: log.truncated,
  };
}
