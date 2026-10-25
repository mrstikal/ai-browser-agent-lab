import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AGENT_RUN_DEFAULT_LIMITS,
  AGENT_WORKER_HEARTBEAT_MS,
  AGENT_WORKER_MAX_ERROR_CHARS,
  AGENT_WORKER_MAX_EVENTS,
  AGENT_WORKER_MAX_TASK_CHARS,
  AGENT_WORKER_MIN_HEARTBEAT_MS,
  AGENT_WORKER_MAX_HEARTBEAT_MS,
  agentRunLimitsSchema,
  agentWorkerMessageSchema,
  isObservedBrowserToolEvent,
  type AgentRunLimits,
  type AgentWorkerEventMessage,
  type AgentWorkerResultMessage,
} from "../lib/agent-ipc";
import { HEALTH_MARKER } from "../lib/health";
import {
  agentPresetTaskIdSchema,
  buildPresetTaskInstruction,
  type AgentPresetTaskId,
} from "../lib/agent-tasks";
import {
  AgentCompatibilityError,
  loadAgentCompatibility,
} from "./agent-compatibility";
import {
  terminateAgentWorkerGroup,
  type AgentGroupTermination,
} from "./agent-group";
import {
  loadAgentRecoveryReport,
  recordUnresolvedAgentGroup,
} from "./agent-recovery";
import {
  AGENT_RUN_VERSION,
  AgentRunError,
  appendAgentEvent,
  isTerminalAgentRunStatus,
  listAgentRuns,
  saveAgentRun,
  type AgentFormBaseline,
  type AgentRunCancelReason,
  type AgentRunRecord,
  type AgentRunWorker,
} from "./agent-runs";
import {
  AgentFormBaselineLimitError,
  captureFormBaseline,
} from "./agent-form-baseline";
import { resolveAppConfig, type AppConfig } from "./config";
import { getKeyStatus, loadOpenRouterKey } from "./credentials";
import { acquireLock, LockError, LockHeldError, type OwnerLock } from "./lock";
import { loadModelSettings, ModelSettingsCorruptionError } from "./model-settings";
import { AGENT_RUN_LOCK_KIND, PAID_JOB_LOCK_SEGMENTS } from "./paid-lock";
import {
  beginPaidOperation,
  endPaidOperation,
  PaidOperationActiveError,
} from "./paid-operation";
import {
  readBootId,
  readProcessGroupId,
  readProcessStartTicks,
} from "./process-identity";
import { redactText } from "../lib/agent-output";
import { createStorage, type Storage, type StorageEnv } from "./storage";

export const AGENT_WORKER_ENTRY_SEGMENTS = ["src", "worker", "agent-runner.ts"] as const;
export const AGENT_HEALTH_TIMEOUT_MS = 3_000;
export const AGENT_SPAWN_TIMEOUT_MS = 10_000;
export const AGENT_WORKER_STDERR_LIMIT = 8_192;

/**
 * The SDK enforces `limits.timeoutMs` itself. The supervisor watchdog is a
 * backstop that fires shortly after, asks the worker to cancel cooperatively,
 * and then leaves a still-hung worker to Phase 26 forced cleanup.
 */
export const AGENT_WATCHDOG_MARGIN_MS = 5_000;
export const AGENT_CANCEL_GRACE_MS = 10_000;

/** Fixed, bounded verification job limits; independent of the run-task UI. */
export const AGENT_VERIFICATION_LIMITS: AgentRunLimits = Object.freeze({
  maxSteps: 8,
  timeoutMs: 120_000,
  maxCostUsd: 0.25,
});

export class AgentWorkerUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentWorkerUnavailableError";
  }
}

export type AgentGateReason =
  | "verified"
  | "key-required"
  | "sdk-unavailable"
  | "verification-required"
  | "model-mismatch"
  | "origin-mismatch"
  | "sdk-mismatch";

export interface AgentGate {
  readonly keyAvailable: boolean;
  readonly verified: boolean;
  readonly reason: AgentGateReason;
  readonly modelId: string;
  /** Null when the installed SDK manifest is missing or unreadable. */
  readonly sdkVersion: string | null;
  readonly origin: string;
  readonly verifiedAt: string | null;
  readonly vision: "observed" | "unverified";
}

export const AGENT_STATUS_RECOVERY_LIMIT = 20;

export interface AgentRecoveryStatus {
  readonly status: "reconciled" | "skipped" | "failed";
  readonly finishedAt: string;
  readonly corruptRuns: number;
  readonly unresolvedCount: number;
  readonly unresolved: ReadonlyArray<{
    readonly runId: string;
    readonly outcome: "skipped" | "escaped";
    readonly reason: string | null;
    readonly lock: string;
    readonly message: string;
  }>;
}

export interface AgentStatusSnapshot {
  readonly activeRunId: string | null;
  readonly gate: AgentGate;
  readonly runs: readonly AgentRunRecord[];
  readonly corruptRuns: number;
  /** Last startup-recovery report; null when nothing needed reconciliation. */
  readonly recovery: AgentRecoveryStatus | null;
}

export interface AgentWorkerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface AgentRunLimitsInput {
  readonly maxSteps?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxCostUsd?: number | undefined;
}

export interface StartAgentRunOptions {
  /** `verification` runs the fixed heading job; `task` needs a verified model. */
  readonly kind: "verification" | "task";
  readonly task?: string | undefined;
  /**
   * Preset task ID. The supervisor builds the neutral instruction from this ID
   * and the configured origin; `task` must be omitted.
   */
  readonly presetId?: AgentPresetTaskId | undefined;
  readonly limits?: AgentRunLimitsInput | undefined;
  /** Heartbeat interval override (tests/tuning); bounded by the protocol. */
  readonly heartbeatMs?: number | undefined;
  /**
   * Runs once after a fully settled run (terminal state persisted, process
   * group proven gone) while the paid lock is still held. Never called for a
   * hung run or a run whose leftover processes keep the lock. The verification
   * module uses it to evaluate the answer and stamp the model tuple; the
   * supervisor itself never writes that stamp.
   */
  readonly onSettled?:
    | ((record: AgentRunRecord) => unknown)
    | undefined;
  readonly env?: StorageEnv | undefined;
  readonly storage?: Storage | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly repoRoot?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export type AgentStartResult =
  | { readonly status: "started"; readonly run: AgentRunRecord }
  | { readonly status: "run-active"; readonly runId: string }
  | { readonly status: "key-required" }
  | {
      readonly status: "verification-required";
      readonly reason: Exclude<AgentGateReason, "verified">;
    }
  | { readonly status: "paid-operation-active" }
  | { readonly status: "app-unavailable"; readonly message: string }
  | { readonly status: "worker-unavailable"; readonly message: string }
  | { readonly status: "lock-error"; readonly message: string }
  | { readonly status: "invalid-request"; readonly message: string }
  | {
      readonly status: "failed";
      readonly run: AgentRunRecord;
      readonly message: string;
    };

/**
 * A cooperative cancel either records the request (and keeps trying through
 * the worker's channel) or discovers that the run is already past the grace
 * period and can only be stopped by Phase 26 forced cleanup.
 */
type CancelRequestOutcome = "cancelling" | "hung" | "finished";

interface ActiveAgentRun {
  readonly runId: string;
  readonly child: ChildProcess;
  readonly lock: OwnerLock;
  readonly requestCancel: (reason: AgentRunCancelReason) => CancelRequestOutcome;
}

const AGENT_SUPERVISOR_HOLDER_KEY = Symbol.for(
  "ai-browser-agent-lab.agent-supervisor",
);

interface AgentSupervisorHolder {
  readonly runs: Map<string, ActiveAgentRun>;
}

function holder(): AgentSupervisorHolder {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[AGENT_SUPERVISOR_HOLDER_KEY] as
    | AgentSupervisorHolder
    | undefined;
  if (existing) return existing;
  const created: AgentSupervisorHolder = { runs: new Map() };
  host[AGENT_SUPERVISOR_HOLDER_KEY] = created;
  return created;
}

/** Read-only: the in-memory run for one data directory, if this process owns it. */
export function getActiveAgentRunId(storageRoot: string): string | null {
  return holder().runs.get(storageRoot)?.runId ?? null;
}

// Test-only: drops supervisor bookkeeping; children are owned by their tests.
export function resetAgentSupervisorForTests(): void {
  holder().runs.clear();
}

export interface CancelAgentRunOptions {
  readonly runId?: string | undefined;
  readonly env?: StorageEnv | undefined;
  readonly storage?: Storage | undefined;
}

export type CancelAgentRunResult =
  | { readonly status: "cancelling"; readonly runId: string }
  | { readonly status: "run-hung"; readonly runId: string }
  | { readonly status: "run-mismatch"; readonly activeRunId: string }
  | { readonly status: "no-active-run" };

/**
 * Cooperative cancellation: asks the worker to abort the SDK run and close its
 * browser. The run keeps its lock until the worker process is proven gone, so
 * a Stop click can never unlock a still-live paid operation.
 */
export function cancelAgentRun(
  options: CancelAgentRunOptions = {},
): CancelAgentRunResult {
  const env = options.env ?? process.env;
  const storage = options.storage ?? createStorage(env);
  const active = holder().runs.get(storage.root);
  if (!active) return { status: "no-active-run" };
  if (options.runId !== undefined && options.runId !== active.runId) {
    return { status: "run-mismatch", activeRunId: active.runId };
  }
  const outcome = active.requestCancel("user");
  if (outcome === "hung") return { status: "run-hung", runId: active.runId };
  if (outcome === "finished") return { status: "no-active-run" };
  return { status: "cancelling", runId: active.runId };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedErrorText(text: string, secret: string | null): string {
  return (
    redactText(text, secret).slice(0, AGENT_WORKER_MAX_ERROR_CHARS) ||
    "The agent run failed without a message."
  );
}

/**
 * Resolves the standalone worker from the application repository root, never
 * from a `.next` bundle directory, under both `next dev` and built `next start`.
 */
export function resolveAgentWorkerPath(repoRoot: string = process.cwd()): string {
  const root = resolve(repoRoot);
  const workerPath = join(root, ...AGENT_WORKER_ENTRY_SEGMENTS);
  if (!existsSync(workerPath)) {
    throw new AgentWorkerUnavailableError(
      `The agent worker entry ${workerPath} is missing. Run the app from the repository root.`,
    );
  }
  return workerPath;
}

export function buildAgentWorkerCommand(
  repoRoot: string = process.cwd(),
): AgentWorkerCommand {
  const root = resolve(repoRoot);
  const workerPath = resolveAgentWorkerPath(root);
  const tsxManifest = join(root, "node_modules", "tsx", "package.json");
  if (!existsSync(tsxManifest)) {
    throw new AgentWorkerUnavailableError(
      `The tsx runtime dependency is missing at ${tsxManifest}; run npm install.`,
    );
  }
  return {
    command: process.execPath,
    args: ["--import", "tsx", workerPath],
    cwd: root,
  };
}

export async function readInstalledSdkVersion(
  repoRoot: string = process.cwd(),
): Promise<string> {
  const manifestPath = join(
    resolve(repoRoot),
    "node_modules",
    "@browser_use",
    "pi",
    "package.json",
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new AgentWorkerUnavailableError(
      `Cannot read the installed @browser_use/pi manifest at ${manifestPath}; run npm install.`,
      { cause: error },
    );
  }
  const record = manifest as { name?: unknown; version?: unknown };
  if (
    record.name !== "@browser_use/pi" ||
    typeof record.version !== "string" ||
    record.version.length === 0 ||
    record.version.length > 100
  ) {
    throw new AgentWorkerUnavailableError(
      "The installed @browser_use/pi manifest is invalid.",
    );
  }
  return record.version;
}

/**
 * Short, read-only fetch of the configured app health marker. It must pass
 * before the paid lock is acquired or a worker is spawned.
 */
export async function checkAgentAppHealth(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = AGENT_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${origin}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return false;
    const body = (await response.json()) as { ok?: unknown; app?: unknown };
    return body.ok === true && body.app === HEALTH_MARKER;
  } catch {
    return false;
  }
}

export function buildVerificationTask(origin: string): string {
  return [
    `Open ${origin}/shop using only the visible local UI.`,
    "Read the page's main visible heading (the h1 text).",
    'Return JSON exactly like {"heading":"<visible text>"}; copy the text, do not guess.',
  ].join("\n");
}

export function resolveAgentRunLimits(
  input?: AgentRunLimitsInput,
): AgentRunLimits {
  const parsed = agentRunLimitsSchema.safeParse({
    ...AGENT_RUN_DEFAULT_LIMITS,
    ...(input ?? {}),
  });
  if (!parsed.success) {
    throw new AgentRunError("The agent run limits are invalid.");
  }
  return parsed.data;
}

export interface EvaluateAgentGateOptions {
  readonly storage: Storage;
  readonly env?: StorageEnv | undefined;
  readonly config?: AppConfig | undefined;
  readonly repoRoot?: string | undefined;
}

/**
 * The current key plus the app's own verified model/SDK/origin stamp decide
 * whether an arbitrary live task may run. A missing or mismatched stamp allows
 * only the separate fixed verification job.
 */
export async function evaluateAgentGate(
  options: EvaluateAgentGateOptions,
): Promise<AgentGate> {
  const env = options.env ?? process.env;
  const config = options.config ?? resolveAppConfig(env);
  const settings = await loadModelSettings(options.storage);
  let sdkVersion: string | null = null;
  try {
    sdkVersion = await readInstalledSdkVersion(options.repoRoot);
  } catch (error) {
    if (!(error instanceof AgentWorkerUnavailableError)) throw error;
  }
  const keyStatus = await getKeyStatus(env, { sweepTemps: false });
  const compatibility = await loadAgentCompatibility(options.storage);

  let reason: AgentGateReason;
  if (!keyStatus.keyAvailable) {
    reason = "key-required";
  } else if (sdkVersion === null) {
    reason = "sdk-unavailable";
  } else if (!compatibility) {
    reason = "verification-required";
  } else if (compatibility.modelId !== settings.browser.modelId) {
    reason = "model-mismatch";
  } else if (compatibility.origin !== config.origin) {
    reason = "origin-mismatch";
  } else if (compatibility.sdkVersion !== sdkVersion) {
    reason = "sdk-mismatch";
  } else {
    reason = "verified";
  }

  const verified = reason === "verified";
  return {
    keyAvailable: keyStatus.keyAvailable,
    verified,
    reason,
    modelId: settings.browser.modelId,
    sdkVersion,
    origin: config.origin,
    verifiedAt: verified && compatibility ? compatibility.verifiedAt : null,
    vision: verified && compatibility ? compatibility.vision : "unverified",
  };
}

export interface LoadAgentStatusOptions {
  readonly storage?: Storage | undefined;
  readonly env?: StorageEnv | undefined;
  readonly repoRoot?: string | undefined;
}

/** Read-only snapshot for the dashboard: no lock, spawn, or paid request. */
export async function loadAgentStatus(
  options: LoadAgentStatusOptions = {},
): Promise<AgentStatusSnapshot> {
  const env = options.env ?? process.env;
  const storage = options.storage ?? createStorage(env);
  const gate = await evaluateAgentGate({
    storage,
    env,
    repoRoot: options.repoRoot,
  });
  const listed = await listAgentRuns(storage);
  const report = await loadAgentRecoveryReport(storage);
  const unresolved = (report?.runs ?? []).filter(
    (entry) => entry.outcome === "skipped" || entry.outcome === "escaped",
  );
  // The on-disk run record keeps the full baseline for evaluation; status and
  // SSE summaries do not need the ID array and must stay bounded.
  const runs = listed.runs.map((run) =>
    run.formBaseline === null ? run : { ...run, formBaseline: null },
  );
  return {
    activeRunId: getActiveAgentRunId(storage.root),
    gate,
    runs,
    corruptRuns: listed.corrupt,
    recovery: report
      ? {
          status: report.status,
          finishedAt: report.finishedAt,
          corruptRuns: report.corruptRuns,
          unresolvedCount: unresolved.length,
          unresolved: unresolved
            .slice(0, AGENT_STATUS_RECOVERY_LIMIT)
            .map((entry) => ({
              runId: entry.runId,
              outcome: entry.outcome as "skipped" | "escaped",
              reason: entry.reason,
              lock: entry.lock,
              message: entry.message,
            })),
        }
      : null,
  };
}

function buildWorkerEnv(env: StorageEnv, key: string): NodeJS.ProcessEnv {
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length > 0) overrides[name] = value;
  }
  return {
    ...process.env,
    ...overrides,
    OPENROUTER_API_KEY: key,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

function waitForSpawn(
  child: ChildProcess,
  timeoutMs: number,
): Promise<"spawned" | "error" | "timeout"> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise("timeout"), timeoutMs);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolvePromise("spawned");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise("error");
    });
  });
}

async function readWorkerIdentity(pid: number): Promise<AgentRunWorker | null> {
  let bootId: string;
  try {
    bootId = await readBootId();
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [procStartTicks, groupId] = await Promise.all([
      readProcessStartTicks(pid),
      readProcessGroupId(pid),
    ]);
    if (procStartTicks !== undefined && groupId !== undefined) {
      return { pid, groupId, procStartTicks, bootId };
    }
    // Yield event-loop turns instead of wall time so the retry stays neutral
    // under fake-timer tests; the spawn event already implies /proc exists.
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  return null;
}

/**
 * Acquires the shared paid lock with the run UUID as owner, spawns the worker
 * in its own process group, records the run/worker identity, and returns while
 * the run continues in this server process. Terminal state and the bounded
 * event log are persisted by the supervisor, never by the model.
 */
export async function startAgentRun(
  options: StartAgentRunOptions,
): Promise<AgentStartResult> {
  const env = options.env ?? process.env;
  const storage = options.storage ?? createStorage(env);
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  if (
    options.heartbeatMs !== undefined &&
    (!Number.isInteger(options.heartbeatMs) ||
      options.heartbeatMs < AGENT_WORKER_MIN_HEARTBEAT_MS ||
      options.heartbeatMs > AGENT_WORKER_MAX_HEARTBEAT_MS)
  ) {
    return {
      status: "invalid-request",
      message: `The heartbeat interval must be ${AGENT_WORKER_MIN_HEARTBEAT_MS} to ${AGENT_WORKER_MAX_HEARTBEAT_MS} ms.`,
    };
  }

  let presetId: AgentPresetTaskId | null = null;
  if (options.presetId !== undefined) {
    if (options.kind !== "task") {
      return {
        status: "invalid-request",
        message: "Only task runs can use a task preset.",
      };
    }
    if (options.task !== undefined) {
      return {
        status: "invalid-request",
        message: "Provide either a custom task or a task preset, not both.",
      };
    }
    const parsedPreset = agentPresetTaskIdSchema.safeParse(options.presetId);
    if (!parsedPreset.success) {
      return {
        status: "invalid-request",
        message: "The selected task preset is invalid.",
      };
    }
    presetId = parsedPreset.data;
  }

  let task: string;
  let limits: AgentRunLimits;
  if (options.kind === "verification") {
    limits = { ...AGENT_VERIFICATION_LIMITS };
    task = "";
  } else {
    if (presetId === null) {
      const parsedTask = z
        .string()
        .trim()
        .min(1)
        .max(AGENT_WORKER_MAX_TASK_CHARS)
        .safeParse(options.task);
      if (!parsedTask.success) {
        return {
          status: "invalid-request",
          message: `The agent task must be 1 to ${AGENT_WORKER_MAX_TASK_CHARS} characters.`,
        };
      }
      task = parsedTask.data;
    } else {
      // Built after the configured origin is resolved below.
      task = "";
    }
    try {
      limits = resolveAgentRunLimits(options.limits);
    } catch (error) {
      return { status: "invalid-request", message: messageOf(error) };
    }
  }

  let config: AppConfig;
  try {
    config = resolveAppConfig(env);
  } catch (error) {
    return { status: "app-unavailable", message: messageOf(error) };
  }

  if (!(await checkAgentAppHealth(config.origin, fetchImpl))) {
    return {
      status: "app-unavailable",
      message: `The local app at ${config.origin} did not answer its health marker. Start the app at its configured origin and retry.`,
    };
  }

  if (options.kind === "verification") {
    task = buildVerificationTask(config.origin);
  } else if (presetId !== null) {
    task = buildPresetTaskInstruction(config.origin, presetId);
    if (task.length > AGENT_WORKER_MAX_TASK_CHARS) {
      return {
        status: "invalid-request",
        message: "The task preset instruction exceeds the task length cap.",
      };
    }
  }

  let command: AgentWorkerCommand;
  try {
    command = buildAgentWorkerCommand(repoRoot);
  } catch (error) {
    return { status: "worker-unavailable", message: messageOf(error) };
  }

  const alreadyActive = holder().runs.get(storage.root);
  if (alreadyActive) {
    return { status: "run-active", runId: alreadyActive.runId };
  }

  const runId = randomUUID();
  let lock: OwnerLock;
  try {
    lock = await acquireLock(storage, PAID_JOB_LOCK_SEGMENTS, {
      kind: AGENT_RUN_LOCK_KIND,
      ownerId: runId,
      releaseOnExit: true,
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      if (error.owner.kind === AGENT_RUN_LOCK_KIND) {
        return { status: "run-active", runId: error.owner.ownerId };
      }
      return { status: "paid-operation-active" };
    }
    if (error instanceof LockError) {
      return { status: "lock-error", message: error.message };
    }
    throw error;
  }

  const releaseQuietly = async (): Promise<void> => {
    try {
      await lock.release();
    } catch (error) {
      console.error(
        `[agent-supervisor] The agent paid lock could not be released safely: ${messageOf(error)}`,
      );
    }
  };

  try {
    beginPaidOperation(runId, AGENT_RUN_LOCK_KIND);
  } catch (error) {
    await releaseQuietly();
    if (error instanceof PaidOperationActiveError) {
      return { status: "paid-operation-active" };
    }
    throw error;
  }

  const refuse = async (): Promise<void> => {
    endPaidOperation(runId);
    await releaseQuietly();
  };

  // The verification gate and key load run inside the paid-operation guard so
  // a concurrent key change or stamp invalidation cannot slip in before spawn.
  let gate: AgentGate;
  try {
    gate = await evaluateAgentGate({ storage, env, config, repoRoot });
  } catch (error) {
    await refuse();
    throw error;
  }
  if (!gate.keyAvailable) {
    await refuse();
    return { status: "key-required" };
  }
  if (gate.sdkVersion === null) {
    await refuse();
    return {
      status: "worker-unavailable",
      message:
        "The installed @browser_use/pi package metadata is unavailable; run npm install.",
    };
  }
  if (options.kind === "task" && !gate.verified) {
    await refuse();
    return {
      status: "verification-required",
      reason: gate.reason as Exclude<AgentGateReason, "verified">,
    };
  }

  let key: string | undefined;
  try {
    key = await loadOpenRouterKey(env);
  } catch (error) {
    await refuse();
    throw error;
  }
  if (!key) {
    await refuse();
    return { status: "key-required" };
  }

  // The snapshot must reach the initial run record before the worker can
  // submit a new form record. It is taken as late as practical, after the paid
  // lock and gate, so only records created during the run appear as new; a
  // submission before this point belongs to the baseline, not the agent.
  let formBaseline: AgentFormBaseline | null = null;
  try {
    formBaseline = await captureFormBaseline(storage, presetId);
  } catch (error) {
    await refuse();
    if (error instanceof AgentFormBaselineLimitError) {
      return { status: "invalid-request", message: error.message };
    }
    throw error;
  }

  const startedAt = now().toISOString();
  const record: AgentRunRecord = {
    version: AGENT_RUN_VERSION,
    runId,
    kind: options.kind,
    presetId,
    formBaseline,
    task,
    modelId: gate.modelId,
    origin: config.origin,
    limits,
    status: "running",
    stopReason: null,
    startedAt,
    endedAt: null,
    updatedAt: startedAt,
    steps: null,
    durationMs: null,
    outputText: null,
    error: null,
    usage: null,
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "not_evaluated", reason: null },
    uiEvidence: "unverified",
    worker: null,
    eventCount: 0,
    lastSeq: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
  };

  try {
    await saveAgentRun(storage, record);
  } catch (error) {
    await refuse();
    throw error;
  }

  // Shared by the synchronous spawn-failure path and the fully settled path.
  // It runs while the paid lock is still held, so an in-app key change cannot
  // race a verification stamp.
  const runSettledHook = async (): Promise<void> => {
    if (!options.onSettled) return;
    try {
      await options.onSettled({ ...record });
    } catch (error) {
      console.error(
        `[agent-supervisor] The settle hook of agent run ${runId} failed: ${messageOf(error)}`,
      );
    }
  };

  let child: ChildProcess;
  try {
    child = spawn(command.command, [...command.args], {
      cwd: command.cwd,
      env: buildWorkerEnv(env, key),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  } catch (error) {
    record.status = "failed";
    record.error = boundedErrorText(
      `The agent worker could not be started: ${messageOf(error)}`,
      key,
    );
    const endedAt = now().toISOString();
    record.endedAt = endedAt;
    record.updatedAt = endedAt;
    await saveAgentRun(storage, record).catch(() => undefined);
    await runSettledHook();
    await refuse();
    return {
      status: "failed",
      run: { ...record },
      message: record.error ?? "The agent worker could not be started.",
    };
  }

  let writeChain: Promise<void> = Promise.resolve();
  let finished = false;
  let stderrTail = "";
  let eventsUnreadable = false;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let lastHeartbeatAtMs = performance.now();
  let startedSeen = false;
  const heartbeatMs =
    options.heartbeatMs ?? AGENT_WORKER_HEARTBEAT_MS;
  const heartbeatTimeoutMs = Math.max(3 * heartbeatMs, 2_000);

  const clearWatchdogs = (): void => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    watchdogTimer = undefined;
    graceTimer = undefined;
    heartbeatTimer = undefined;
  };

  const startHeartbeatWatch = (): void => {
    heartbeatTimer = setInterval(() => {
      if (finished || record.status !== "running") return;
      // Browser launch happens before `started`; the wall-clock watchdog
      // (re-anchored on `started`) covers that phase, not the liveness check.
      if (!startedSeen) return;
      if (performance.now() - lastHeartbeatAtMs <= heartbeatTimeoutMs) return;
      console.error(
        `[agent-supervisor] Agent run ${runId} stopped sending heartbeats; requesting a cooperative cancel.`,
      );
      requestCancel("heartbeat");
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };

  const enqueue = (write: () => Promise<void>): Promise<void> => {
    const next = writeChain.then(write, write);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const persistRecord = (): void => {
    void enqueue(async () => {
      try {
        // Snapshot inside the queue so event counters updated by earlier
        // appends are part of the terminal record.
        await saveAgentRun(storage, { ...record });
      } catch (error) {
        console.error(
          `[agent-supervisor] Agent run ${runId} could not be persisted: ${messageOf(error)}`,
        );
      }
    });
  };

  const forceTerminateHungRun = async (): Promise<void> => {
    if (finished) return;
    const profileDir = storage.path(["browser-profiles", runId]);
    let termination: AgentGroupTermination;
    try {
      termination = await terminateAgentWorkerGroup(record.worker, {
        profileDir,
      });
    } catch (error) {
      termination = { status: "skipped", reason: "unverifiable", memberPids: [] };
      console.error(
        `[agent-supervisor] Forced cleanup of agent run ${runId} could not inspect the process group: ${messageOf(error)}`,
      );
    }

    if (
      termination.status === "terminated" ||
      termination.status === "already-gone"
    ) {
      // The kills skipped the worker's own cleanup, so remove its disposable
      // profile once the group is proven gone. The child exit handler may
      // have settled the run meanwhile; the removal still applies.
      await rm(profileDir, { recursive: true, force: true }).catch((error: unknown) => {
        console.error(
          `[agent-supervisor] The disposable browser profile of agent run ${runId} could not be removed: ${messageOf(error)}`,
        );
      });
      if (finished) return;
      markFailed(
        termination.status === "terminated"
          ? `The worker did not answer the cancel; its verified process group was force-terminated (${termination.signals.join(", ")}).`
          : "The worker did not answer the cancel; its process group was already gone.",
      );
      await finish();
      return;
    }

    if (finished) return;

    const note =
      termination.status === "skipped"
        ? `Forced cleanup could not verify the worker process group (${termination.reason}); a live browser may remain and needs manual cleanup (group members: ${termination.memberPids.join(", ") || "none"}).`
        : `Forced cleanup left processes behind (${termination.remainingPids.join(", ")}); manual cleanup is required.`;
    record.error = boundedErrorText(
      `${record.error ?? "The run is hung."} ${note}`.trim(),
      key,
    );
    record.updatedAt = now().toISOString();
    persistRecord();
    console.error(
      `[agent-supervisor] Agent run ${runId} is hung and could not be force-terminated safely: ${note}`,
    );
  };

  const armGraceTimer = (): void => {
    if (graceTimer !== undefined) return;
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (finished || isTerminalAgentRunStatus(record.status)) return;
      const expiredAt = now().toISOString();
      record.status = "hung";
      record.watchdogExpiredAt = expiredAt;
      record.updatedAt = expiredAt;
      record.error = boundedErrorText(
        record.cancelReason === "user"
          ? "The worker did not answer the cancel within the grace period; the run is marked for forced cleanup."
          : record.cancelReason === "heartbeat"
            ? "The worker stopped sending heartbeats and did not answer the cancel within the grace period; the run is marked for forced cleanup."
            : "The worker did not answer the wall-clock cancel within the grace period; the run is marked for forced cleanup.",
        key,
      );
      persistRecord();
      console.error(
        `[agent-supervisor] Agent run ${runId} did not settle within the cancel grace period; starting verified forced cleanup.`,
      );
      void forceTerminateHungRun();
    }, AGENT_CANCEL_GRACE_MS);
    graceTimer.unref?.();
  };

  const armWatchdog = (): void => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = undefined;
      if (finished || isTerminalAgentRunStatus(record.status)) return;
      requestCancel("watchdog");
    }, limits.timeoutMs + AGENT_WATCHDOG_MARGIN_MS);
    watchdogTimer.unref?.();
  };

  const sendCancelMessage = (reason: AgentRunCancelReason): void => {
    try {
      child.send({
        type: "cancel",
        reason:
          reason === "watchdog"
            ? "wall-clock timeout"
            : reason === "heartbeat"
              ? "heartbeat liveness check"
              : "user request",
      });
    } catch (error) {
      // The worker may already be gone; the exit handler settles the run.
      console.error(
        `[agent-supervisor] Agent run ${runId} could not send its cancel message: ${messageOf(error)}`,
      );
    }
  };

  const requestCancel = (reason: AgentRunCancelReason): CancelRequestOutcome => {
    // The record turns terminal slightly before the child exits; a cancel for
    // a finished run must not arm timers or claim a state change.
    if (isTerminalAgentRunStatus(record.status)) return "finished";
    if (record.status === "hung") {
      // Past the grace period: the cooperative path is exhausted, but a
      // recovered worker may still honor a late cancel before Phase 26 acts.
      sendCancelMessage(reason);
      return "hung";
    }
    if (record.status === "running") {
      const requestedAt = now().toISOString();
      record.status = "cancelling";
      record.cancelRequestedAt = requestedAt;
      record.cancelReason = record.cancelReason ?? reason;
      record.updatedAt = requestedAt;
      persistRecord();
    }
    sendCancelMessage(reason);
    // Any cancel escalates to `hung` if the worker does not settle in time.
    armGraceTimer();
    return "cancelling";
  };

  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    clearWatchdogs();
    await writeChain.catch(() => undefined);
    // The settle hook runs before the paid lock is released: an in-app key
    // change is refused while the operation is active, so a verification
    // stamp cannot race a credential replacement.
    await runSettledHook();
    const current = holder().runs.get(storage.root);
    if (current?.runId === runId) holder().runs.delete(storage.root);
    endPaidOperation(runId);
    await releaseQuietly();
  };

  const markFailed = (reason: string): void => {
    if (isTerminalAgentRunStatus(record.status)) return;
    clearWatchdogs();
    record.status = "failed";
    record.error = boundedErrorText(
      eventsUnreadable
        ? `Some agent events could not be persisted; the trace is incomplete. ${reason}`
        : reason,
      key,
    );
    const endedAt = now().toISOString();
    record.endedAt = endedAt;
    record.updatedAt = endedAt;
    persistRecord();
  };

  const markCompleted = (message: AgentWorkerResultMessage): void => {
    if (isTerminalAgentRunStatus(record.status)) return;
    clearWatchdogs();
    record.status = "completed";
    record.stopReason = message.status;
    record.steps = message.steps;
    record.durationMs = message.durationMs;
    record.outputText = message.outputText;
    record.error =
      message.status === "completed"
        ? null
        : boundedErrorText(message.error ?? "The SDK run did not complete.", key);
    if (eventsUnreadable) {
      const traceNote =
        "Some agent events could not be persisted; the trace is incomplete.";
      record.error = boundedErrorText(
        record.error ? `${traceNote} ${record.error}` : traceNote,
        key,
      );
    }
    record.usage = message.usage;
    record.imageInputObserved =
      record.imageInputObserved || message.imageInputObserved;
    record.vision = record.imageInputObserved ? "observed" : "unverified";
    const endedAt = now().toISOString();
    record.endedAt = endedAt;
    record.updatedAt = endedAt;
    persistRecord();
  };

  let acceptedSeq = 0;
  let acceptedEvents = 0;
  const persistEvent = (message: AgentWorkerEventMessage): void => {
    if (isTerminalAgentRunStatus(record.status)) return;
    if (eventsUnreadable) return;
    if (acceptedEvents >= AGENT_WORKER_MAX_EVENTS) return;
    if (message.seq <= acceptedSeq) return;
    acceptedSeq = message.seq;
    acceptedEvents += 1;
    if (message.imageContent === true) record.imageInputObserved = true;
    void enqueue(async () => {
      try {
        await appendAgentEvent(storage, message);
        record.eventCount += 1;
        record.lastSeq = Math.max(record.lastSeq, message.seq);
        // UI evidence is only claimed for a successfully persisted browser
        // JavaScript tool event. The SDK does not expose page-action events, so
        // this is trace evidence that a browser tool ran, not proof that the
        // cell used a page primitive. Delivery tools such as `finish` are not
        // UI use, and business evaluation stays a separate field.
        if (
          isObservedBrowserToolEvent(message) &&
          record.uiEvidence !== "observed"
        ) {
          // The terminal save persists this field. A nested persist here could
          // land after the settle hook and overwrite its evaluation.
          record.uiEvidence = "observed";
        }
      } catch {
        // Counts only advance for events that really reached disk; the first
        // failure marks the trace incomplete for both terminal paths.
        eventsUnreadable = true;
      }
    });
  };

  const protocolViolation = (detail: string): void => {
    if (isTerminalAgentRunStatus(record.status)) return;
    try {
      child.send({ type: "cancel", reason: "protocol violation" });
    } catch {
      // The worker may already be gone; the exit handler still cleans up.
    }
    markFailed(`The worker sent an invalid IPC message (${detail}).`);
  };

  child.on("message", (raw: unknown) => {
    const parsed = agentWorkerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      protocolViolation("schema mismatch");
      return;
    }
    const message = parsed.data;
    // Any validated message from the worker proves the process is alive; the
    // browser launch can legitimately take a while before the first heartbeat.
    lastHeartbeatAtMs = performance.now();
    if (message.type === "ready") return;
    if (message.type === "started") {
      if (message.runId !== runId) {
        protocolViolation("run id mismatch");
        return;
      }
      // The SDK budget starts when the worker launches the run, so re-anchor
      // the watchdog; the pre-start timer stays the boot fallback. The
      // liveness check only starts counting from here.
      startedSeen = true;
      lastHeartbeatAtMs = performance.now();
      if (!finished && !isTerminalAgentRunStatus(record.status)) armWatchdog();
      return;
    }
    if (message.type === "heartbeat") {
      if (message.runId !== runId) {
        protocolViolation("run id mismatch");
        return;
      }
      return;
    }
    if (message.type === "error") {
      // Pre-start failures may carry a null run id; a foreign id is a violation.
      if (message.runId !== null && message.runId !== runId) {
        protocolViolation("run id mismatch");
        return;
      }
      markFailed(message.message);
      return;
    }
    if (message.runId !== runId) {
      protocolViolation("run id mismatch");
      return;
    }
    if (message.type === "event") {
      persistEvent(message);
      return;
    }
    markCompleted(message);
  });

  child.once("error", (error) => {
    markFailed(`The agent worker process failed: ${messageOf(error)}`);
    if (child.pid === undefined) {
      // The process never spawned, so no group can exist.
      void finish();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      // The child is already reaped; its exit handler owns settlement and the
      // verified group scan, so releasing here could skip that proof.
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Keep the lock held below if the process cannot be proven gone.
    }
    // Releasing the paid lock without proof of exit could let a second paid
    // operation start beside a live worker; Phase 26 owns forced group
    // cleanup, so an unkillable child leaves the lock for recovery.
    const grace = setTimeout(() => {
      console.error(
        `[agent-supervisor] Agent worker ${child.pid ?? "unknown"} may still be alive after a process error; the paid lock stays held for recovery.`,
      );
    }, 3_000);
    child.once("exit", () => clearTimeout(grace));
  });

  /**
   * A dead leader is not proof that its group is gone: a hard-killed worker
   * can leave browser helpers behind. The lock and holder entry are released
   * only after a verified scan shows no owned process remains; otherwise the
   * run is reported and the paid lock stays held for manual cleanup.
   */
  const settleAfterExit = async (): Promise<void> => {
    if (finished) return;
    const worker = record.worker;
    if (!worker) {
      await finish();
      return;
    }
    const profileDir = storage.path(["browser-profiles", runId]);
    let termination: AgentGroupTermination;
    try {
      termination = await terminateAgentWorkerGroup(worker, { profileDir });
    } catch (error) {
      termination = { status: "skipped", reason: "unverifiable", memberPids: [] };
      console.error(
        `[agent-supervisor] Post-exit cleanup of agent run ${runId} could not inspect the process group: ${messageOf(error)}`,
      );
    }
    if (
      termination.status === "terminated" ||
      termination.status === "already-gone"
    ) {
      await rm(profileDir, { recursive: true, force: true }).catch((error: unknown) => {
        console.error(
          `[agent-supervisor] The disposable browser profile of agent run ${runId} could not be removed: ${messageOf(error)}`,
        );
      });
      await finish();
      return;
    }

    if (finished) return;
    const note =
      termination.status === "skipped"
        ? `The worker process group could not be verified after exit (${termination.reason}); a live browser may remain and needs manual cleanup (group members: ${termination.memberPids.join(", ") || "none"}).`
        : `Processes were left behind after exit (${termination.remainingPids.join(", ")}); manual cleanup is required.`;
    record.error = boundedErrorText(
      `${record.error ?? "The worker exited."} ${note}`.trim(),
      key,
    );
    record.updatedAt = now().toISOString();
    persistRecord();
    if (record.kind === "task") {
      // The lock and holder stay for manual cleanup, but the task evaluation
      // is still persisted once the terminal record reaches disk.
      await writeChain.catch(() => undefined);
      await runSettledHook();
    }
    console.error(
      `[agent-supervisor] Agent run ${runId} left processes behind after exit; the paid lock stays held. ${note}`,
    );
    await recordUnresolvedAgentGroup(storage, {
      runId,
      previousStatus: record.status,
      outcome: termination.status,
      reason: termination.status === "skipped" ? termination.reason : null,
      signals: termination.status === "escaped" ? [...termination.signals] : [],
      memberPids: termination.status === "skipped" ? [...termination.memberPids] : [],
      remainingPids: termination.status === "escaped" ? [...termination.remainingPids] : [],
      lock: "held",
      message: note,
    }).catch((error: unknown) => {
      console.error(
        `[agent-supervisor] The unresolved agent group of run ${runId} could not be recorded: ${messageOf(error)}`,
      );
    });
  };

  child.once("exit", (code, signal) => {
    clearWatchdogs();
    if (!isTerminalAgentRunStatus(record.status)) {
      const detailLimit = Math.max(200, AGENT_WORKER_MAX_ERROR_CHARS - 200);
      const detail = stderrTail
        ? ` ${redactText(stderrTail, key).slice(-detailLimit)}`
        : "";
      const hungNote =
        record.watchdogExpiredAt !== null
          ? " The supervisor force-terminated its verified process group after the watchdog grace period."
          : "";
      markFailed(
        boundedErrorText(
          `The worker exited before reporting a result (code ${code ?? "none"}, signal ${signal ?? "none"}).${hungNote}${detail}`,
          key,
        ),
      );
    }
    void settleAfterExit();
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-AGENT_WORKER_STDERR_LIMIT);
  });
  child.stdout?.resume();

  const spawned = await waitForSpawn(child, AGENT_SPAWN_TIMEOUT_MS);
  if (spawned !== "spawned") {
    if (spawned === "timeout") {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already be gone.
      }
      markFailed("The agent worker did not spawn within the allowed time.");
    }
    await writeChain.catch(() => undefined);
    const message = record.error ?? "The agent worker could not be started.";
    return { status: "failed", run: { ...record }, message };
  }

  const workerIdentity =
    child.pid === undefined ? null : await readWorkerIdentity(child.pid);
  if (workerIdentity === null) {
    if (record.status === "running") {
      markFailed("The agent worker process identity could not be verified.");
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already be gone.
      }
    }
    await writeChain.catch(() => undefined);
    return {
      status: "failed",
      run: { ...record },
      message: record.error ?? "The agent worker identity could not be verified.",
    };
  }

  const statusNow = (): AgentRunRecord["status"] => record.status;

  record.worker = workerIdentity;
  record.updatedAt = now().toISOString();
  await enqueue(async () => {
    await saveAgentRun(storage, { ...record });
  }).catch(() => undefined);

  if (statusNow() === "failed") {
    return {
      status: "failed",
      run: { ...record },
      message: record.error ?? "The agent worker failed during startup.",
    };
  }

  if (!finished) {
    holder().runs.set(storage.root, { runId, child, lock, requestCancel });
  }

  // Bounded wall-clock watchdog: the boot fallback fires at the SDK timeout
  // plus a margin and is re-anchored when the worker reports `started`; a
  // worker that still does not settle within the grace period is marked `hung`
  // for Phase 26 forced cleanup and keeps the paid lock.
  armWatchdog();

  // The worker starts billing only after this validated start message; the
  // key itself travels through the child environment, never through IPC.
  try {
    child.send(
      {
        type: "start",
        runId,
        model: gate.modelId,
        task,
        startUrl: config.origin,
        limits,
        headless: false,
        heartbeatMs,
      },
      (error) => {
        if (!error) return;
        markFailed(
          `The agent worker could not receive its start message: ${messageOf(error)}`,
        );
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may already be gone.
        }
      },
    );
  } catch (error) {
    markFailed(
      `The agent worker could not receive its start message: ${messageOf(error)}`,
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }

  if (statusNow() === "failed") {
    return {
      status: "failed",
      run: { ...record },
      message: record.error ?? "The agent worker could not be started.",
    };
  }

  lastHeartbeatAtMs = performance.now();
  startHeartbeatWatch();
  return { status: "started", run: { ...record } };
}

/** Re-exported so status callers can distinguish settings corruption. */
export { ModelSettingsCorruptionError, AgentCompatibilityError };
