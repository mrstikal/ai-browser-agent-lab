"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AGENT_UI_MODES,
  AGENT_UI_MODE_LABELS,
  type AgentUiMode,
} from "@/lib/agent-ui-mode";
import { guardedJsonFetch, readErrorMessage } from "@/app/setup/guard-fetch";

export interface UiModeSwitcherProps {
  readonly mode: AgentUiMode;
  readonly error?: string | null;
}

export function UiModeSwitcher({ mode, error = null }: UiModeSwitcherProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<AgentUiMode | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  async function select(next: AgentUiMode): Promise<void> {
    if (next === mode || busy !== null) return;
    setBusy(next);
    setFeedback(null);
    setRequestError(null);
    try {
      const response = await guardedJsonFetch("/api/ui/mode", {
        method: "POST",
        body: { mode: next },
      });
      if (!response.ok) {
        setRequestError(await readErrorMessage(response));
        return;
      }
      setFeedback(`${AGENT_UI_MODE_LABELS[next]} layout applied.`);
      router.refresh();
    } catch {
      setRequestError("The layout mode could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="ui-mode-heading"
      data-testid="ui-mode-switcher"
      data-ui-mode={mode}
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id="ui-mode-heading" className="text-sm font-semibold">
            Layout
          </h2>
          <p className="max-w-2xl text-sm text-slate-600">
            Classic and Alternate use the same data, routes, and task
            instructions; only the catalog controls, cards, and form fields are
            arranged differently. Each agent run records the mode at its start.
          </p>
        </div>
        <div
          role="group"
          aria-label="Layout mode"
          className="flex flex-wrap gap-2"
        >
          {AGENT_UI_MODES.map((candidate) => {
            const current = candidate === mode;
            return (
              <button
                key={candidate}
                type="button"
                aria-pressed={current}
                disabled={busy !== null}
                onClick={() => void select(candidate)}
                data-testid={`ui-mode-${candidate}`}
                className={
                  current
                    ? "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-70"
                    : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-slate-500 disabled:opacity-50"
                }
              >
                {AGENT_UI_MODE_LABELS[candidate]}
                {current ? <span className="sr-only"> (current)</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <p
        role="status"
        aria-live="polite"
        data-testid="ui-mode-feedback"
        className="mt-3 text-sm text-slate-600"
      >
        {busy !== null
          ? `Applying ${AGENT_UI_MODE_LABELS[busy]} layout...`
          : (feedback ?? `Current layout: ${AGENT_UI_MODE_LABELS[mode]}.`)}
      </p>
      {error ?? requestError ? (
        <p
          role="alert"
          data-testid="ui-mode-error"
          className="mt-2 text-sm text-red-700"
        >
          {requestError ?? error}
        </p>
      ) : null}
    </section>
  );
}
