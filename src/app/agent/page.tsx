import type { Metadata } from "next";
import Link from "next/link";
import {
  AGENT_VERIFICATION_LIMITS,
  loadAgentStatus,
  type AgentStatusSnapshot,
} from "@/server/agent-manager";
import { pickAgentVerificationView } from "@/lib/agent-verification-view";
import { VerifyAgentModelForm } from "./verify-agent-model-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent",
};

export default async function AgentPage() {
  let status: AgentStatusSnapshot | null = null;
  let error: string | null = null;
  try {
    status = await loadAgentStatus();
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
          One dedicated local Chromium session runs one task at a time. Verify the current
          browser model before any live task, then inspect the run trace and its independent
          evaluation.
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

      {status ? (
        <VerifyAgentModelForm
          initial={pickAgentVerificationView(status)}
          limits={AGENT_VERIFICATION_LIMITS}
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
