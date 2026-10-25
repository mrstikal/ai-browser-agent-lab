import { z } from "zod";

/**
 * Captured UI mode. Phase 35 records the persisted Classic/Alternate mode at
 * the start of each new agent run; records created before Phase 35 normalize
 * to `null` so history can say "not captured".
 */
export const AGENT_UI_MODES = ["classic", "alternate"] as const;

export const agentUiModeSchema = z.enum(AGENT_UI_MODES);
export type AgentUiMode = z.infer<typeof agentUiModeSchema>;

export const AGENT_UI_MODE_LABELS: Record<AgentUiMode, string> = {
  classic: "Classic",
  alternate: "Alternate",
};
