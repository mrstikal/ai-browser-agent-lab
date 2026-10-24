import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  terminateAgentWorkerGroup,
  type AgentGroupTermination,
} from "./agent-group";
import { getActiveAgentRunId } from "./agent-manager";
import {
  AGENT_RUN_VERSION,
  agentRunLifecycleSchema,
  isActiveAgentRunStatus,
  listActiveAgentRuns,
  loadAgentRun,
  saveAgentRun,
  type AgentRunLifecycle,
  type AgentRunRecord,
} from "./agent-runs";
import { evaluateCatalogTaskRun } from "./agent-task-evaluation";
import { acquireLock, LockError, LockHeldError, readLockMetadata } from "./lock";
import { AGENT_RUN_LOCK_KIND, PAID_JOB_LOCK_SEGMENTS } from "./paid-lock";
import type { ProcOptions } from "./process-identity";
import { redactText } from "../lib/agent-output";
import type { Storage } from "./storage";

/**
 * Restart recovery for supervised agent runs. A run whose record is still
 * active belongs to a supervisor that is gone; the worker's recorded process
 * group is verified before anything is signaled, orphan runs are marked
 * `interrupted`, and the shared paid lock is released only after the group is
 * proven gone. Uncertain or escaped groups are reported for manual cleanup
 * instead of being signaled blindly.
 */

export const AGENT_RECOVERY_FILE = "agent-recovery.json";
export const AGENT_RECOVERY_VERSION = 1 as const;
export const AGENT_RECOVERY_MAX_MESSAGE_CHARS = 1_000;

export const agentRecoveryOutcomeSchema = z.enum([
  "terminated",
  "already-gone",
  "skipped",
  "escaped",
]);
export type AgentRecoveryOutcome = z.infer<typeof agentRecoveryOutcomeSchema>;

export const agentRecoveryLockSchema = z.enum([
  "released",
  "held",
  "absent",
  "not-ours",
  "error",
]);
export type AgentRecoveryLock = z.infer<typeof agentRecoveryLockSchema>;

export const agentRecoveryRunSchema = z.strictObject({
  runId: z.uuid(),
  previousStatus: agentRunLifecycleSchema,
  outcome: agentRecoveryOutcomeSchema,
  reason: z.string().max(200).nullable(),
  signals: z.array(z.enum(["SIGTERM", "SIGKILL"])),
  memberPids: z.array(z.number().int().positive()),
  remainingPids: z.array(z.number().int().positive()),
  lock: agentRecoveryLockSchema,
  message: z.string().min(1).max(AGENT_RECOVERY_MAX_MESSAGE_CHARS),
});
export type AgentRecoveryRunReport = z.infer<typeof agentRecoveryRunSchema>;

export const agentRecoveryReportSchema = z.strictObject({
  version: z.literal(AGENT_RECOVERY_VERSION),
  finishedAt: z.iso.datetime(),
  status: z.enum(["reconciled", "skipped", "failed"]),
  message: z.string().max(AGENT_RECOVERY_MAX_MESSAGE_CHARS).optional(),
  corruptRuns: z.number().int().nonnegative(),
  runs: z.array(agentRecoveryRunSchema),
});
export type AgentRecoveryReport = z.infer<typeof agentRecoveryReportSchema>;

export interface RecoverInterruptedAgentStateOptions extends ProcOptions {
  readonly storage: Storage;
  readonly profileRoot?: readonly string[] | undefined;
  readonly sigtermGraceMs?: number | undefined;
  readonly sigkillGraceMs?: number | undefined;
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
}

export async function loadAgentRecoveryReport(
  storage: Storage,
): Promise<AgentRecoveryReport | undefined> {
  let raw: unknown;
  try {
    raw = await storage.readJson<unknown>([AGENT_RECOVERY_FILE]);
  } catch (error) {
    // A corrupt report must not take down status pages or recovery; the
    // persistent barrier lock still protects the paid operation.
    console.error(
      `[agent-recovery] The agent recovery report is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (raw === undefined) return undefined;
  const parsed = agentRecoveryReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function boundedMessage(text: string): string {
  return (
    redactText(text, null).slice(0, AGENT_RECOVERY_MAX_MESSAGE_CHARS) ||
    "Agent recovery completed without a message."
  );
}

function outcomeOf(termination: AgentGroupTermination): AgentRecoveryOutcome {
  return termination.status === "skipped" ? "skipped" : termination.status;
}

function terminationMessage(
  termination: AgentGroupTermination,
  runId: string,
): string {
  switch (termination.status) {
    case "terminated":
      return `The app restarted while this run was active; its verified worker process group was terminated (${termination.signals.join(", ")}).`;
    case "already-gone":
      return "The app restarted while this run was active; its worker process group was already gone.";
    case "skipped":
      return `The app restarted while this run was active. The worker process group could not be verified (${termination.reason}); a live browser from this run may still exist and needs manual cleanup (group members: ${termination.memberPids.join(", ") || "none"}).`;
    case "escaped":
      return `The app restarted while this run was active. Forced termination left processes behind (${termination.remainingPids.join(", ")}); manual cleanup is required. Check the browser profile for run ${runId}.`;
  }
}

/**
 * Reclaims a stale lock and keeps it under this live process so the paid lock
 * genuinely blocks both agent and image starts until manual cleanup. Merely
 * leaving the dead supervisor's file in place would be cosmetic: the next
 * `acquireLock` reclaims it.
 */
async function holdAgentLockForManualCleanup(
  storage: Storage,
  runId: string,
): Promise<AgentRecoveryLock> {
  let metadata;
  try {
    metadata = await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS));
  } catch (error) {
    if (error instanceof LockError) return "error";
    throw error;
  }
  if (
    metadata !== undefined &&
    (metadata.kind !== AGENT_RUN_LOCK_KIND || metadata.ownerId !== runId)
  ) {
    return "not-ours";
  }
  try {
    // No releaseOnExit here: the barrier file must survive this process so the
    // next boot can reclaim it and keep blocking until manual cleanup. When the
    // file is absent (already removed) the barrier is created from scratch.
    await acquireLock(storage, PAID_JOB_LOCK_SEGMENTS, {
      kind: AGENT_RUN_LOCK_KIND,
      ownerId: runId,
      maxAttempts: 2,
    });
    // Deliberately kept: it is the barrier for manual cleanup.
    return "held";
  } catch (error) {
    if (error instanceof LockHeldError) return "held";
    if (error instanceof LockError) return "error";
    throw error;
  }
}

async function releaseStaleAgentLock(
  storage: Storage,
  runId: string,
): Promise<AgentRecoveryLock> {
  let metadata;
  try {
    metadata = await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS));
  } catch (error) {
    if (error instanceof LockError) return "error";
    throw error;
  }
  if (metadata === undefined) return "absent";
  if (metadata.kind !== AGENT_RUN_LOCK_KIND || metadata.ownerId !== runId) {
    return "not-ours";
  }

  // acquireLock reclaims the lock only when the recorded owner is provably
  // gone (dead process, reused PID, or a changed boot ID); an active owner is
  // left strictly alone.
  try {
    // One attempt reclaims the stale file and a second creates ours; an
    // active owner throws LockHeldError on the first attempt instead.
    const lock = await acquireLock(storage, PAID_JOB_LOCK_SEGMENTS, {
      kind: AGENT_RUN_LOCK_KIND,
      ownerId: runId,
      maxAttempts: 2,
    });
    await lock.release();
    return "released";
  } catch (error) {
    if (error instanceof LockHeldError) return "held";
    if (error instanceof LockError) return "error";
    throw error;
  }
}

/**
 * Reconciles interrupted agent runs for one data directory. Called at server
 * startup; never contacts OpenRouter and never signals an unverified group.
 */
export async function recoverInterruptedAgentState(
  options: RecoverInterruptedAgentStateOptions,
): Promise<AgentRecoveryReport> {
  const storage = options.storage;
  const now = options.now ?? (() => new Date());
  const active = await listActiveAgentRuns(storage);
  const runs: AgentRecoveryRunReport[] = [];

  const inspect = async (
    run: AgentRunRecord,
  ): Promise<AgentGroupTermination> => {
    const profileDir = storage.path(
      options.profileRoot ?? ["browser-profiles", run.runId],
    );
    try {
      return await terminateAgentWorkerGroup(run.worker, {
        profileDir,
        procRoot: options.procRoot,
        sigtermGraceMs: options.sigtermGraceMs,
        sigkillGraceMs: options.sigkillGraceMs,
        sleepImpl: options.sleepImpl,
      });
    } catch (error) {
      // One unreadable /proc entry must not abort recovery for other runs.
      console.error(
        `[agent-recovery] Agent run ${run.runId} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "skipped", reason: "unverifiable", memberPids: [] };
    }
  };

  const settleGroup = async (
    run: AgentRunRecord,
    termination: AgentGroupTermination,
  ): Promise<AgentRecoveryLock> => {
    const groupGone =
      termination.status === "terminated" ||
      termination.status === "already-gone";
    const lock = groupGone
      ? await releaseStaleAgentLock(storage, run.runId)
      : await holdAgentLockForManualCleanup(storage, run.runId);
    if (groupGone) {
      // The forced kills skipped the worker's own cleanup; the profile of an
      // orphan run is disposable once its group is proven gone.
      const profileDir = storage.path(
        options.profileRoot ?? ["browser-profiles", run.runId],
      );
      await rm(profileDir, { recursive: true, force: true }).catch(
        (error: unknown) => {
          console.error(
            `[agent-recovery] The disposable browser profile of run ${run.runId} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    }
    return lock;
  };

  const toReport = (
    run: AgentRunRecord,
    termination: AgentGroupTermination,
    lock: AgentRecoveryLock,
    message: string,
  ): AgentRecoveryRunReport => ({
    runId: run.runId,
    previousStatus: run.status as AgentRunLifecycle,
    outcome: outcomeOf(termination),
    reason: termination.status === "skipped" ? termination.reason : null,
    signals:
      termination.status === "terminated" || termination.status === "escaped"
        ? [...termination.signals]
        : [],
    memberPids:
      termination.status === "skipped" ? [...termination.memberPids] : [],
    remainingPids:
      termination.status === "escaped" ? [...termination.remainingPids] : [],
    lock,
    message: boundedMessage(message),
  });

  const processed = new Set<string>();
  for (const run of active.runs) {
    if (getActiveAgentRunId(storage.root) === run.runId) continue;
    processed.add(run.runId);
    const termination = await inspect(run);
    const lock = await settleGroup(run, termination);
    const message = terminationMessage(termination, run.runId);
    const endedAt = now().toISOString();
    const updated: AgentRunRecord = {
      ...run,
      version: AGENT_RUN_VERSION,
      status: "interrupted",
      error: boundedMessage(message),
      endedAt,
      updatedAt: endedAt,
    };
    // A preset task that terminates through restart recovery still gets its
    // one deterministic business evaluation; it can never be a pass.
    if (
      updated.kind === "task" &&
      updated.presetId !== null &&
      updated.evaluation.status === "not_evaluated"
    ) {
      updated.evaluation = evaluateCatalogTaskRun(updated);
    }
    await saveAgentRun(storage, updated);
    runs.push(toReport(run, termination, lock, message));
  }

  // Uncertain groups from earlier boots stay quarantined: retry them so the
  // paid lock remains a real barrier across restarts and is cleared only once
  // the group is proven gone.
  const previous = await loadAgentRecoveryReport(storage);
  for (const entry of previous?.runs ?? []) {
    if (entry.outcome !== "skipped" && entry.outcome !== "escaped") continue;
    if (processed.has(entry.runId)) continue;
    let run: AgentRunRecord | undefined;
    try {
      run = await loadAgentRun(storage, entry.runId);
    } catch {
      // The record is unreadable; keep the unresolved entry for a later boot
      // instead of dropping the barrier knowledge.
      console.error(
        `[agent-recovery] Unresolved run ${entry.runId} still has an unreadable record; keeping its barrier entry.`,
      );
      runs.push(entry);
      continue;
    }
    if (!run || isActiveAgentRunStatus(run.status)) continue;
    const termination = await inspect(run);
    const lock = await settleGroup(run, termination);
    const message = terminationMessage(termination, run.runId);
    if (
      termination.status === "terminated" ||
      termination.status === "already-gone"
    ) {
      const endedAt = now().toISOString();
      const updated: AgentRunRecord = {
        ...run,
        error: boundedMessage(
          `${run.error ?? "The run was interrupted."} Manual cleanup is no longer needed; the worker process group is gone.`,
        ),
        updatedAt: endedAt,
      };
      // Backfill a preset task that became terminal in an earlier build whose
      // recovery path did not yet evaluate it. The once-only check preserves
      // any existing evaluation.
      if (
        updated.kind === "task" &&
        updated.presetId !== null &&
        updated.evaluation.status === "not_evaluated"
      ) {
        updated.evaluation = evaluateCatalogTaskRun(updated);
      }
      await saveAgentRun(storage, updated);
    }
    runs.push({
      ...toReport(run, termination, lock, message),
      // Keep the original lifecycle status across retries for honesty.
      previousStatus: entry.previousStatus,
    });
  }

  const report: AgentRecoveryReport = {
    version: AGENT_RECOVERY_VERSION,
    finishedAt: now().toISOString(),
    status: runs.length > 0 ? "reconciled" : "skipped",
    corruptRuns: active.corrupt,
    runs,
  };
  if (runs.length > 0 || active.corrupt > 0) {
    await storage.writeJson([AGENT_RECOVERY_FILE], report);
  }
  return report;
}

/**
 * Upserts one unresolved worker-group entry into the recovery report. The live
 * supervisor calls this when it must keep the paid lock after an exit; the next
 * boot's recovery retries the group and clears the barrier once it is gone.
 */
export async function recordUnresolvedAgentGroup(
  storage: Storage,
  entry: AgentRecoveryRunReport,
): Promise<void> {
  const previous = await loadAgentRecoveryReport(storage);
  const boundedEntry: AgentRecoveryRunReport = {
    ...entry,
    message: boundedMessage(entry.message),
  };
  const runs = [
    ...(previous?.runs.filter((run) => run.runId !== entry.runId) ?? []),
    boundedEntry,
  ];
  const failed = previous?.status === "failed";
  const report: AgentRecoveryReport = {
    version: AGENT_RECOVERY_VERSION,
    finishedAt: new Date().toISOString(),
    status: failed ? "failed" : "reconciled",
    ...(failed && previous?.message !== undefined
      ? { message: previous.message }
      : {}),
    corruptRuns: previous?.corruptRuns ?? 0,
    runs,
  };
  await storage.writeJson([AGENT_RECOVERY_FILE], report);
}

/**
 * Persists a short failure marker so a broken recovery is visible later. Any
 * unresolved worker-group entries from earlier boots are preserved: dropping
 * them would let the next paid start reclaim the barrier lock without a group
 * check.
 */
export async function recordAgentRecoveryFailure(
  storage: Storage,
  message: string,
): Promise<void> {
  const previous = await loadAgentRecoveryReport(storage).catch(() => undefined);
  const unresolved =
    previous?.runs.filter(
      (entry) => entry.outcome === "skipped" || entry.outcome === "escaped",
    ) ?? [];
  const report: AgentRecoveryReport = {
    version: AGENT_RECOVERY_VERSION,
    finishedAt: new Date().toISOString(),
    status: "failed",
    message: boundedMessage(message),
    corruptRuns: previous?.corruptRuns ?? 0,
    runs: unresolved,
  };
  await storage.writeJson([AGENT_RECOVERY_FILE], report);
}
