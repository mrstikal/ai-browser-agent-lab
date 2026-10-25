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
import {
  AGENT_FORM_BASELINE_SCHEMA_MAX_IDS,
  agentFormTaskTypeSchema,
  agentPresetTaskIdSchema,
  type AgentPresetTaskId,
} from "../lib/agent-tasks";
import {
  agentUiModeSchema,
  type AgentUiMode,
} from "../lib/agent-ui-mode";
import { browserModelIdSchema } from "../lib/schemas";
import { Storage, StorageCorruptionError } from "./storage";

/**
 * Written version. Version 1 records (Phase 24) lack the cancellation fields
 * and are still accepted on read; everything is normalized to version 2.
 */
export const AGENT_RUN_VERSION = 2 as const;
/** Version 1 records (Phase 24) are still accepted and normalized on read. */
const AGENT_RUN_READABLE_VERSIONS = [1, AGENT_RUN_VERSION] as const;
export const AGENT_RUNS_DIR = "agent-runs";
export const AGENT_EVENTS_DIR = "agent-events";
export const AGENT_RUN_LIST_LIMIT = 50;
export const AGENT_RUN_MAX_LIST_LIMIT = 200;

export const agentRunKindSchema = z.enum(["verification", "task"]);
export type AgentRunKind = z.infer<typeof agentRunKindSchema>;

/**
 * `running` -> `cancelling` -> terminal, or `running` -> `hung` when the
 * watchdog grace period expires before any terminal result; `hung` marks the
 * run for verified forced cleanup. `interrupted` is written by restart
 * recovery for orphan runs whose supervisor is gone. Terminal statuses are
 * `completed`, `failed`, and `interrupted`; `completed` only means the worker
 * delivered a terminal result, so always surface `stopReason` too.
 */
export const agentRunLifecycleSchema = z.enum([
  "running",
  "cancelling",
  "hung",
  "completed",
  "failed",
  "interrupted",
]);
export type AgentRunLifecycle = z.infer<typeof agentRunLifecycleSchema>;

export const agentRunCancelReasonSchema = z.enum([
  "user",
  "watchdog",
  "heartbeat",
]);
export type AgentRunCancelReason = z.infer<typeof agentRunCancelReasonSchema>;

export function isActiveAgentRunStatus(status: AgentRunLifecycle): boolean {
  return status === "running" || status === "cancelling" || status === "hung";
}

export function isTerminalAgentRunStatus(status: AgentRunLifecycle): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export const agentRunEvaluationSchema = z.strictObject({
  status: z.enum(["not_evaluated", "passed", "failed"]),
  reason: z.string().max(1_000).nullable(),
});
export type AgentRunEvaluation = z.infer<typeof agentRunEvaluationSchema>;

/**
 * Snapshot of existing form-submission IDs taken before a form-task worker is
 * launched. It is stored in the run record so the terminal evaluator can
 * require exactly one new record and an old matching record can never satisfy
 * a later run.
 */
export const agentFormBaselineSchema = z.strictObject({
  form: agentFormTaskTypeSchema,
  submissionIds: z
    .array(z.string().min(1).max(200))
    .max(AGENT_FORM_BASELINE_SCHEMA_MAX_IDS),
});
export type AgentFormBaseline = z.infer<typeof agentFormBaselineSchema>;

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
export const agentRunRecordSchema = z
  .strictObject({
    version: z.union([
      z.literal(AGENT_RUN_READABLE_VERSIONS[0]),
      z.literal(AGENT_RUN_READABLE_VERSIONS[1]),
    ]),
    runId: z.uuid(),
    kind: agentRunKindSchema,
    /** Preset task ID; null for custom tasks and verification runs. */
    presetId: agentPresetTaskIdSchema.nullable().optional(),
    /**
     * Captured UI mode; null when the optional alternate UI was not in use or
     * the record predates Phase 32.
     */
    uiMode: agentUiModeSchema.nullable().optional(),
    /** Existing submission IDs captured before a form-task worker launch. */
    formBaseline: agentFormBaselineSchema.nullable().optional(),
    task: z.string().min(1).max(AGENT_WORKER_MAX_TASK_CHARS),
    modelId: browserModelIdSchema,
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
    /** Actual Navigate page action recorded by the SDK; optional for old runs. */
    navigationObserved: z.boolean().optional(),
    /** Click/Type interaction recorded by the SDK; optional for old runs. */
    interactionObserved: z.boolean().optional(),
    /** URL the browser was on when the run ended; optional for old runs. */
    finalUrl: z.string().max(300).nullable().optional(),
    worker: agentRunWorkerSchema.nullable(),
    eventCount: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    // Optional only for version 1 records; version 2 requires them.
    cancelRequestedAt: z.iso.datetime().nullable().optional(),
    cancelReason: agentRunCancelReasonSchema.nullable().optional(),
    watchdogExpiredAt: z.iso.datetime().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.version !== AGENT_RUN_VERSION) return;
    for (const field of [
      "cancelRequestedAt",
      "cancelReason",
      "watchdogExpiredAt",
    ] as const) {
      if (value[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: `${field} is required for version ${AGENT_RUN_VERSION} records.`,
          path: [field],
        });
      }
    }
  });

type RawAgentRunRecord = z.infer<typeof agentRunRecordSchema>;

/** Normalized in-memory shape: version 2 with every field present. */
export type AgentRunRecord = Omit<
  RawAgentRunRecord,
  | "version"
  | "presetId"
  | "uiMode"
  | "formBaseline"
  | "cancelRequestedAt"
  | "cancelReason"
  | "watchdogExpiredAt"
> & {
  version: typeof AGENT_RUN_VERSION;
  presetId: AgentPresetTaskId | null;
  uiMode: AgentUiMode | null;
  formBaseline: AgentFormBaseline | null;
  cancelRequestedAt: string | null;
  cancelReason: AgentRunCancelReason | null;
  watchdogExpiredAt: string | null;
};

export function normalizeAgentRunRecord(raw: RawAgentRunRecord): AgentRunRecord {
  return {
    ...raw,
    version: AGENT_RUN_VERSION,
    presetId: raw.presetId ?? null,
    uiMode: raw.uiMode ?? null,
    formBaseline: raw.formBaseline ?? null,
    cancelRequestedAt: raw.cancelRequestedAt ?? null,
    cancelReason: raw.cancelReason ?? null,
    watchdogExpiredAt: raw.watchdogExpiredAt ?? null,
    navigationObserved: raw.navigationObserved ?? false,
    interactionObserved: raw.interactionObserved ?? false,
    finalUrl: raw.finalUrl ?? null,
  };
}

/**
 * Client-facing run projection. The form baseline is server-only evaluation
 * state and must not be serialized into API responses.
 */
export function stripAgentRunBaseline(run: AgentRunRecord): AgentRunRecord {
  return run.formBaseline === null ? run : { ...run, formBaseline: null };
}

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
  return normalizeAgentRunRecord(parsed.data);
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

async function scanAgentRuns(
  storage: Storage,
): Promise<{ runs: AgentRunRecord[]; corrupt: number }> {
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
  return { runs, corrupt };
}

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
  const { runs, corrupt } = await scanAgentRuns(storage);
  return { runs: runs.slice(0, limit), corrupt };
}

export interface ActiveAgentRunList {
  /** Every non-terminal run, newest first and unbounded. */
  readonly runs: readonly AgentRunRecord[];
  /** Run files that could not be read or validated during the scan. */
  readonly corrupt: number;
}

/**
 * Every run that is not terminal (newest first, unbounded). Restart recovery
 * needs the whole set, not the newest page, so orphans cannot hide behind the
 * display limit; corrupt files are counted so recovery can report them.
 */
export async function listActiveAgentRuns(
  storage: Storage,
): Promise<ActiveAgentRunList> {
  const { runs, corrupt } = await scanAgentRuns(storage);
  return { runs: runs.filter((run) => isActiveAgentRunStatus(run.status)), corrupt };
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
