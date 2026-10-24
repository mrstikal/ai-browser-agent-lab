import type { Metadata } from "next";
import Link from "next/link";
import {
  AGENT_RUN_DEFAULT_LIMITS,
  AGENT_RUN_MAX_COST_USD,
  AGENT_RUN_MAX_STEPS,
  AGENT_RUN_MAX_TIMEOUT_MS,
  AGENT_WORKER_MAX_TASK_CHARS,
} from "@/lib/agent-ipc";
import {
  pickAgentDashboardView,
  selectTraceRun,
  type AgentDashboardView,
} from "@/lib/agent-dashboard-view";
import { EMPTY_AGENT_TRACE, type AgentTraceState } from "@/lib/agent-trace";
import { loadAgentTraceView } from "@/server/agent-trace";
import { createStorage } from "@/server/storage";
import {
  AGENT_VERIFICATION_LIMITS,
  loadAgentStatus,
  type AgentStatusSnapshot,
} from "@/server/agent-manager";
import { AgentDashboard } from "./agent-dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent",
};

export default async function AgentPage() {
  let status: AgentStatusSnapshot | null = null;
  let view: AgentDashboardView | null = null;
  let initialTrace: AgentTraceState = EMPTY_AGENT_TRACE;
  let initialTraceError: string | null = null;
  let error: string | null = null;
  try {
    const storage = createStorage();
    status = await loadAgentStatus({ storage });
    view = pickAgentDashboardView(status);
    const traceRun = selectTraceRun(view);
    if (traceRun !== null) {
      try {
        initialTrace = await loadAgentTraceView(storage, traceRun.runId);
      } catch {
        initialTraceError =
          "The saved trace is unreadable; the run itself is unaffected.";
      }
    }
  } catch {
    error =
      "Saved agent state is unreadable. Inspect data/agent-runs and data/agent-compatibility.json; no work was started.";
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Local browser agent
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Agent dashboard</h1>
        <p className="max-w-2xl text-slate-600">
          One dedicated local Chromium session runs one task at a time. Verify
          the current browser model, then start a bounded task and inspect its
          execution status, output, and independent evaluation separately.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      {status && view ? (
        <AgentDashboard
          initial={view}
          initialTrace={initialTrace}
          initialTraceError={initialTraceError}
          initialCorruptRuns={status.corruptRuns}
          verificationLimits={AGENT_VERIFICATION_LIMITS}
          taskDefaults={AGENT_RUN_DEFAULT_LIMITS}
          taskCaps={{
            maxSteps: AGENT_RUN_MAX_STEPS,
            maxTimeoutMs: AGENT_RUN_MAX_TIMEOUT_MS,
            maxCostUsd: AGENT_RUN_MAX_COST_USD,
          }}
          maxTaskChars={AGENT_WORKER_MAX_TASK_CHARS}
        />
      ) : null}

      <p className="text-sm text-slate-600">
        Image generation and the API key are managed in{" "}
        <Link href="/setup" className="font-medium underline">
          Setup
        </Link>
        . The catalog stays browsable at{" "}
        <Link href="/shop" className="font-medium underline">
          /shop
        </Link>
        .
      </p>
    </div>
  );
}
