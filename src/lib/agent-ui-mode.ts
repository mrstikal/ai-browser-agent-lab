import { z } from "zod";

/**
 * Optional captured UI mode. Phase 32 displays it when a run record carries it;
 * the optional alternate UI (Phase 35) is responsible for recording it at the
 * start of each run. Existing runs and custom starts stay `null`.
 */
export const AGENT_UI_MODES = ["classic", "alternate"] as const;

export const agentUiModeSchema = z.enum(AGENT_UI_MODES);
export type AgentUiMode = z.infer<typeof agentUiModeSchema>;

export const AGENT_UI_MODE_LABELS: Record<AgentUiMode, string> = {
  classic: "Classic",
  alternate: "Alternate",
};
