import { z } from "zod";
import { browserModelIdSchema } from "./schemas";

/**
 * Validated IPC contract between the agent supervisor and the one-run worker
 * child process (`src/worker/agent-runner.ts`).
 *
 * Parent to worker: exactly one `start` message and optional idempotent
 * `cancel` messages. Worker to parent: `ready`, `started`, bounded `event`
 * messages, then exactly one terminal `result` or `error`. Message text is
 * redacted and bounded by the worker before it is sent.
 */

/** Plan defaults: 30 steps, 180 seconds, $1.00 soft cost cap. */
export const AGENT_RUN_DEFAULT_LIMITS = Object.freeze({
  maxSteps: 30,
  timeoutMs: 180_000,
  maxCostUsd: 1,
});

/** Hard protocol caps; the UI may offer smaller values only. */
export const AGENT_RUN_MAX_STEPS = 200;
export const AGENT_RUN_MIN_TIMEOUT_MS = 10_000;
export const AGENT_RUN_MAX_TIMEOUT_MS = 1_800_000;
export const AGENT_RUN_MAX_COST_USD = 100;

export const AGENT_WORKER_MAX_EVENTS = 1_000;
/**
 * Periodic liveness heartbeat while a run is active. The supervisor derives
 * its silence timeout from this interval (at least 3x, never below 2 s).
 */
export const AGENT_WORKER_HEARTBEAT_MS = 5_000;
export const AGENT_WORKER_MIN_HEARTBEAT_MS = 250;
export const AGENT_WORKER_MAX_HEARTBEAT_MS = 30_000;
export const AGENT_WORKER_MAX_OUTPUT_CHARS = 20_000;
export const AGENT_WORKER_MAX_ERROR_CHARS = 2_000;
export const AGENT_WORKER_MAX_TASK_CHARS = 4_000;

/** SDK stop reasons plus a completed run; kept in the SDK's own spelling. */
export const AGENT_RUN_STATUSES = [
  "completed",
  "max_steps",
  "timeout",
  "cancelled",
  "cost_limit",
  "context_limit",
  "incomplete",
  "error",
] as const;

export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(AGENT_RUN_MAX_STEPS),
  timeoutMs: z
    .number()
    .int()
    .min(AGENT_RUN_MIN_TIMEOUT_MS)
    .max(AGENT_RUN_MAX_TIMEOUT_MS),
  maxCostUsd: z.number().positive().max(AGENT_RUN_MAX_COST_USD),
});
export type AgentRunLimits = z.infer<typeof agentRunLimitsSchema>;

export const agentStartMessageSchema = z.strictObject({
  type: z.literal("start"),
  runId: z.uuid(),
  model: browserModelIdSchema,
  task: z.string().trim().min(1).max(AGENT_WORKER_MAX_TASK_CHARS),
  startUrl: z.string().trim().min(1).max(300),
  limits: agentRunLimitsSchema,
  headless: z.boolean(),
  /** Heartbeat interval; defaults to AGENT_WORKER_HEARTBEAT_MS. */
  heartbeatMs: z
    .number()
    .int()
    .min(AGENT_WORKER_MIN_HEARTBEAT_MS)
    .max(AGENT_WORKER_MAX_HEARTBEAT_MS)
    .optional(),
});
export type AgentStartMessage = z.infer<typeof agentStartMessageSchema>;

export const agentCancelMessageSchema = z.strictObject({
  type: z.literal("cancel"),
  reason: z.string().trim().max(200).optional(),
});
export type AgentCancelMessage = z.infer<typeof agentCancelMessageSchema>;

export const agentParentMessageSchema = z.discriminatedUnion("type", [
  agentStartMessageSchema,
  agentCancelMessageSchema,
]);
export type AgentParentMessage = z.infer<typeof agentParentMessageSchema>;

export const agentWorkerReadyMessageSchema = z.strictObject({
  type: z.literal("ready"),
});

export const agentWorkerStartedMessageSchema = z.strictObject({
  type: z.literal("started"),
  runId: z.uuid(),
  startedAt: z.iso.datetime(),
});
export type AgentWorkerStartedMessage = z.infer<
  typeof agentWorkerStartedMessageSchema
>;

export const AGENT_WORKER_EVENT_KINDS = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_start",
  "tool_end",
] as const;

export const agentWorkerEventKindSchema = z.enum(AGENT_WORKER_EVENT_KINDS);
export type AgentWorkerEventKind = z.infer<typeof agentWorkerEventKindSchema>;

export const agentWorkerHeartbeatMessageSchema = z.strictObject({
  type: z.literal("heartbeat"),
  runId: z.uuid(),
  at: z.iso.datetime(),
});
export type AgentWorkerHeartbeatMessage = z.infer<
  typeof agentWorkerHeartbeatMessageSchema
>;

export const agentWorkerEventMessageSchema = z.strictObject({
  type: z.literal("event"),
  runId: z.uuid(),
  seq: z.number().int().min(1).max(1_000_000),
  at: z.iso.datetime(),
  kind: agentWorkerEventKindSchema,
  toolName: z.string().min(1).max(120).optional(),
  isError: z.boolean().optional(),
  imageContent: z.boolean().optional(),
});
export type AgentWorkerEventMessage = z.infer<
  typeof agentWorkerEventMessageSchema
>;

export const agentWorkerUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
});
export type AgentWorkerUsage = z.infer<typeof agentWorkerUsageSchema>;

export const agentWorkerResultMessageSchema = z.strictObject({
  type: z.literal("result"),
  runId: z.uuid(),
  status: agentRunStatusSchema,
  outputText: z.string().max(AGENT_WORKER_MAX_OUTPUT_CHARS),
  error: z.string().max(AGENT_WORKER_MAX_ERROR_CHARS).nullable(),
  steps: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  usage: agentWorkerUsageSchema,
  imageInputObserved: z.boolean(),
  pageActionObserved: z.boolean(),
  navigationObserved: z.boolean(),
  finalUrl: z.string().max(300).nullable(),
});
export type AgentWorkerResultMessage = z.infer<
  typeof agentWorkerResultMessageSchema
>;

export const agentWorkerErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  runId: z.uuid().nullable(),
  message: z.string().min(1).max(AGENT_WORKER_MAX_ERROR_CHARS),
});
export type AgentWorkerErrorMessage = z.infer<
  typeof agentWorkerErrorMessageSchema
>;

export const agentWorkerMessageSchema = z.discriminatedUnion("type", [
  agentWorkerReadyMessageSchema,
  agentWorkerStartedMessageSchema,
  agentWorkerHeartbeatMessageSchema,
  agentWorkerEventMessageSchema,
  agentWorkerResultMessageSchema,
  agentWorkerErrorMessageSchema,
]);
export type AgentWorkerMessage = z.infer<typeof agentWorkerMessageSchema>;

export const AGENT_WORKER_READY_MESSAGE: AgentWorkerMessage = { type: "ready" };
