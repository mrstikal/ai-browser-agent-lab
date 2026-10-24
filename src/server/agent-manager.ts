import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AGENT_RUN_DEFAULT_LIMITS,
  AGENT_WORKER_MAX_ERROR_CHARS,
  AGENT_WORKER_MAX_EVENTS,
  AGENT_WORKER_MAX_TASK_CHARS,
  agentRunLimitsSchema,
  agentWorkerMessageSchema,
  type AgentRunLimits,
  type AgentWorkerEventMessage,
  type AgentWorkerResultMessage,
} from "../lib/agent-ipc";
import { HEALTH_MARKER } from "../lib/health";
import {
  AgentCompatibilityError,
  loadAgentCompatibility,
} from "./agent-compatibility";
import {
  AgentRunError,
  appendAgentEvent,
  listAgentRuns,
  saveAgentRun,
  type AgentRunRecord,
  type AgentRunWorker,
} from "./agent-runs";
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

export interface AgentStatusSnapshot {
  readonly activeRunId: string | null;
  readonly gate: AgentGate;
  readonly runs: readonly AgentRunRecord[];
  readonly corruptRuns: number;
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
  readonly limits?: AgentRunLimitsInput | undefined;
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

interface ActiveAgentRun {
  readonly runId: string;
  readonly child: ChildProcess;
  readonly lock: OwnerLock;
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
  return {
    activeRunId: getActiveAgentRunId(storage.root),
    gate,
    runs: listed.runs,
    corruptRuns: listed.corrupt,
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const [procStartTicks, groupId] = await Promise.all([
      readProcessStartTicks(pid),
      readProcessGroupId(pid),
    ]);
    if (procStartTicks !== undefined && groupId !== undefined) {
      return { pid, groupId, procStartTicks, bootId };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
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

  let task: string;
  let limits: AgentRunLimits;
  if (options.kind === "verification") {
    limits = { ...AGENT_VERIFICATION_LIMITS };
    task = "";
  } else {
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
    try {
      limits = resolveAgentRunLimits(options.limits);
    } catch (error) {
      return { status: "invalid-request", message: messageOf(error) };
    }
    task = parsedTask.data;
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

  const startedAt = now().toISOString();
  const record: AgentRunRecord = {
    version: 1,
    runId,
    kind: options.kind,
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
  };

  try {
    await saveAgentRun(storage, record);
  } catch (error) {
    await refuse();
    throw error;
  }

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

  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await writeChain.catch(() => undefined);
    const current = holder().runs.get(storage.root);
    if (current?.runId === runId) holder().runs.delete(storage.root);
    endPaidOperation(runId);
    await releaseQuietly();
  };

  const markFailed = (reason: string): void => {
    if (record.status !== "running") return;
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
    if (record.status !== "running") return;
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
    if (record.status !== "running") return;
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
      } catch {
        // Counts only advance for events that really reached disk; the first
        // failure marks the trace incomplete for both terminal paths.
        eventsUnreadable = true;
      }
    });
  };

  const protocolViolation = (detail: string): void => {
    if (record.status !== "running") return;
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
    if (message.type === "ready") return;
    if (message.type === "started") {
      if (message.runId !== runId) protocolViolation("run id mismatch");
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
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      void finish();
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

  child.once("exit", (code, signal) => {
    if (record.status === "running") {
      const detailLimit = Math.max(200, AGENT_WORKER_MAX_ERROR_CHARS - 200);
      const detail = stderrTail
        ? ` ${redactText(stderrTail, key).slice(-detailLimit)}`
        : "";
      markFailed(
        boundedErrorText(
          `The worker exited before reporting a result (code ${code ?? "none"}, signal ${signal ?? "none"}).${detail}`,
          key,
        ),
      );
    }
    void finish();
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
    holder().runs.set(storage.root, { runId, child, lock });
  }

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
  return { status: "started", run: { ...record } };
}

/** Re-exported so status callers can distinguish settings corruption. */
export { ModelSettingsCorruptionError, AgentCompatibilityError };
