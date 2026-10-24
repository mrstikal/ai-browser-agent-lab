import { z } from "zod";
import {
  AGENT_WORKER_MAX_ERROR_CHARS,
  AGENT_WORKER_MAX_OUTPUT_CHARS,
  AGENT_WORKER_MAX_TASK_CHARS,
  agentRunLimitsSchema,
  agentRunStatusSchema,
  agentWorkerEventMessageSchema,
  agentWorkerUsageSchema,
  type AgentWorkerEventMessage,
} from "../lib/agent-ipc";
import { modelIdSchema } from "../lib/schemas";
import { Storage, StorageCorruptionError } from "./storage";

export const AGENT_RUN_VERSION = 1 as const;
export const AGENT_RUNS_DIR = "agent-runs";
export const AGENT_EVENTS_DIR = "agent-events";
export const AGENT_RUN_LIST_LIMIT = 50;
export const AGENT_RUN_MAX_LIST_LIMIT = 200;

export const agentRunKindSchema = z.enum(["verification", "task"]);
export type AgentRunKind = z.infer<typeof agentRunKindSchema>;

export const agentRunLifecycleSchema = z.enum(["running", "completed", "failed"]);
export type AgentRunLifecycle = z.infer<typeof agentRunLifecycleSchema>;

export const agentRunEvaluationSchema = z.strictObject({
  status: z.enum(["not_evaluated", "passed", "failed"]),
  reason: z.string().max(1_000).nullable(),
});
export type AgentRunEvaluation = z.infer<typeof agentRunEvaluationSchema>;

export const agentRunWorkerSchema = z.strictObject({
  pid: z.number().int().positive(),
  groupId: z.number().int().positive(),
  procStartTicks: z.number().int().nonnegative(),
  bootId: z.string().min(1).max(128),
});
export type AgentRunWorker = z.infer<typeof agentRunWorkerSchema>;

/**
 * Durable run summary. One JSON snapshot per run, atomically replaced; the
 * chronological SDK trace lives in `agent-events/<runId>.jsonl` instead.
 */
export const agentRunRecordSchema = z.strictObject({
  version: z.literal(AGENT_RUN_VERSION),
  runId: z.uuid(),
  kind: agentRunKindSchema,
  task: z.string().min(1).max(AGENT_WORKER_MAX_TASK_CHARS),
  modelId: modelIdSchema,
  origin: z.string().min(1).max(300),
  limits: agentRunLimitsSchema,
  status: agentRunLifecycleSchema,
  stopReason: agentRunStatusSchema.nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  steps: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  outputText: z.string().max(AGENT_WORKER_MAX_OUTPUT_CHARS).nullable(),
  error: z.string().max(AGENT_WORKER_MAX_ERROR_CHARS).nullable(),
  usage: agentWorkerUsageSchema.nullable(),
  imageInputObserved: z.boolean(),
  vision: z.enum(["observed", "unverified"]),
  evaluation: agentRunEvaluationSchema,
  uiEvidence: z.enum(["observed", "unverified"]),
  worker: agentRunWorkerSchema.nullable(),
  eventCount: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
});
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;

export class AgentRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRunError";
  }
}

export class AgentRunCorruptionError extends StorageCorruptionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRunCorruptionError";
  }
}

function assertRunId(runId: string): void {
  if (!z.uuid().safeParse(runId).success) {
    throw new AgentRunError("Agent run IDs must be UUIDs.");
  }
}

export function agentRunFileSegments(runId: string): readonly string[] {
  assertRunId(runId);
  return [AGENT_RUNS_DIR, `${runId}.json`];
}

export function agentEventFileSegments(runId: string): readonly string[] {
  assertRunId(runId);
  return [AGENT_EVENTS_DIR, `${runId}.jsonl`];
}

export function parseAgentRunRecord(value: unknown): AgentRunRecord {
  const parsed = agentRunRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentRunCorruptionError(
      `Agent run record is invalid: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export async function saveAgentRun(
  storage: Storage,
  record: AgentRunRecord,
): Promise<void> {
  await storage.writeJson(
    agentRunFileSegments(record.runId),
    parseAgentRunRecord(record),
  );
}

export async function loadAgentRun(
  storage: Storage,
  runId: string,
): Promise<AgentRunRecord | undefined> {
  let raw: unknown;
  try {
    raw = await storage.readJson<unknown>(agentRunFileSegments(runId));
  } catch (error) {
    if (error instanceof StorageCorruptionError) {
      throw new AgentRunCorruptionError(
        `Saved agent run ${runId} contains malformed JSON. Inspect data/${AGENT_RUNS_DIR}/${runId}.json.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (raw === undefined) return undefined;
  return parseAgentRunRecord(raw);
}

export interface AgentRunList {
  /** Newest first, bounded by the requested limit. */
  readonly runs: readonly AgentRunRecord[];
  /** Number of run files that could not be read or validated. */
  readonly corrupt: number;
}

const RUN_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

export async function listAgentRuns(
  storage: Storage,
  limit: number = AGENT_RUN_LIST_LIMIT,
): Promise<AgentRunList> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > AGENT_RUN_MAX_LIST_LIMIT
  ) {
    throw new AgentRunError(
      `The agent run list limit must be an integer from 1 to ${AGENT_RUN_MAX_LIST_LIMIT}.`,
    );
  }

  const names = await storage.listFiles([AGENT_RUNS_DIR]);
  const runs: AgentRunRecord[] = [];
  let corrupt = 0;
  for (const name of names) {
    const match = RUN_FILE_PATTERN.exec(name);
    if (!match?.[1]) {
      if (name.endsWith(".json")) corrupt += 1;
      continue;
    }
    const runId = match[1];
    try {
      const raw = await storage.readJson<unknown>(agentRunFileSegments(runId));
      if (raw === undefined) continue;
      runs.push(parseAgentRunRecord(raw));
    } catch {
      corrupt += 1;
    }
  }

  runs.sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      right.runId.localeCompare(left.runId),
  );
  return { runs: runs.slice(0, limit), corrupt };
}

/** Appends one validated, already-bounded worker event. */
export async function appendAgentEvent(
  storage: Storage,
  event: AgentWorkerEventMessage,
): Promise<void> {
  const parsed = agentWorkerEventMessageSchema.safeParse(event);
  if (!parsed.success) {
    throw new AgentRunError("Refusing to append an invalid agent event record.");
  }
  await storage.appendJsonLine(
    agentEventFileSegments(parsed.data.runId),
    parsed.data,
  );
}

export interface AgentEventLog {
  readonly events: readonly AgentWorkerEventMessage[];
  /** True when a crash left a truncated final line; it is not returned. */
  readonly truncated: boolean;
}

export async function loadAgentEvents(
  storage: Storage,
  runId: string,
): Promise<AgentEventLog> {
  const { records, truncated } = await storage.readJsonLines<unknown>(
    agentEventFileSegments(runId),
  );
  const events: AgentWorkerEventMessage[] = [];
  for (const record of records) {
    const parsed = agentWorkerEventMessageSchema.safeParse(record);
    if (!parsed.success || parsed.data.runId !== runId) {
      throw new AgentRunCorruptionError(
        `The agent event log for ${runId} contains an invalid record.`,
      );
    }
    events.push(parsed.data);
  }
  return { events, truncated };
}
