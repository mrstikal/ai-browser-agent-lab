export const HEALTH_MARKER = "ai-browser-agent-lab";

export const HEALTH_PAYLOAD = {
  ok: true,
  app: HEALTH_MARKER,
} as const;

export type HealthPayload = typeof HEALTH_PAYLOAD;
