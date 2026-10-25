import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  terminateAgentWorkerGroup,
  type AgentGroupTermination,
} from "./agent-group";
import { getActiveAgentRunId } from "./agent-manager";
import {
  AGENT_RUN_VERSION,
  AgentRunCorruptionError,
  agentRunLifecycleSchema,
  isActiveAgentRunStatus,
  isTerminalAgentRunStatus,
  listActiveAgentRuns,
  loadAgentRun,
  saveAgentRun,
  type AgentRunLifecycle,
  type AgentRunRecord,
} from "./agent-runs";
import { evaluatePresetTaskRun } from "./agent-preset-evaluation";
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
  // `null` means the record could not be read, so its original lifecycle is
  // unknown. The entry still carries the unresolved barrier obligation.
  previousStatus: agentRunLifecycleSchema.nullable(),
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
  const processed = new Set<string>();
  const previous = await loadAgentRecoveryReport(storage);
  // A result is persisted before the worker closes its browser. If the server
  // dies in that window, the run is already terminal but still owns the paid
  // lock and a live process group. The lock is the durable pointer to that
  // cleanup obligation, independent of the run's execution status. This must
  // cover failed and interrupted runs too: a crash can land after the terminal
  // status was persisted but before the supervisor recorded an unresolved
  // group, so the unresolved-report retry path has no entry yet.
  const cleanupOnly: AgentRunRecord[] = [];
  try {
    const metadata = await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS));
    if (
      metadata?.kind === AGENT_RUN_LOCK_KIND &&
      getActiveAgentRunId(storage.root) !== metadata.ownerId &&
      !active.runs.some((run) => run.runId === metadata.ownerId)
    ) {
      let run: AgentRunRecord | undefined;
      let unknownReason: "record-missing" | "record-unreadable" | null = null;
      try {
        run = await loadAgentRun(storage, metadata.ownerId);
        if (!run) unknownReason = "record-missing";
      } catch (error) {
        if (!(error instanceof AgentRunCorruptionError)) throw error;
        unknownReason = "record-unreadable";
      }
      if (run && isTerminalAgentRunStatus(run.status)) {
        // A run with an unresolved-report entry is owned by the retry loop,
        // which inspects the group and backfills its evaluation. Runs without
        // an entry are in the crash window between terminal persistence and
        // unresolved-group recording, so inspect them here.
        const hasRetryEntry =
          previous?.runs.some(
            (entry) =>
              entry.runId === run.runId &&
              (entry.outcome === "skipped" || entry.outcome === "escaped"),
          ) ?? false;
        if (!hasRetryEntry) cleanupOnly.push(run);
      } else if (unknownReason !== null) {
        // The lock points at a run we cannot read. Keeping the stale lock file
        // is not enough: the next acquireLock would reclaim it. Reclaim it
        // under this live process and report the manual-cleanup obligation.
        const lock = await holdAgentLockForManualCleanup(
          storage,
          metadata.ownerId,
        );
        processed.add(metadata.ownerId);
        runs.push({
          runId: metadata.ownerId,
          previousStatus: null,
          outcome: "skipped",
          reason: unknownReason,
          signals: [],
          memberPids: [],
          remainingPids: [],
          lock,
          message: boundedMessage(
            `The paid lock references agent run ${metadata.ownerId}, but its record is ${unknownReason === "record-missing" ? "missing" : "unreadable"}. The paid barrier is held until the record is restored or the run's processes are cleaned up manually (lock ${lock}).`,
          ),
        });
      }
    }
  } catch (error) {
    console.error(
      `[agent-recovery] The paid lock could not be inspected for post-result cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const inspect = async (
    run: AgentRunRecord,
  ): Promise<AgentGroupTermination> => {
    // `start` is only sent after the worker identity is persisted, so a null
    // identity proves the worker never launched a browser.
    if (!run.worker) return { status: "already-gone" };
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
      updated.evaluation = await evaluatePresetTaskRun(updated, storage);
    }
    await saveAgentRun(storage, updated);
    runs.push(toReport(run, termination, lock, message));
  }

  for (const run of cleanupOnly) {
    if (processed.has(run.runId)) continue;
    processed.add(run.runId);
    const termination = run.worker
      ? await inspect(run)
      : ({ status: "already-gone" } as AgentGroupTermination);
    // This branch covers the crash window between terminal persistence and the
    // settle hook. A preset run can therefore be terminal with no persisted
    // evaluation. Persist the backfill while the paid lock is still held: the
    // lock is the only durable pointer to this run, so releasing it first
    // would make a crash in this gap lose the verdict permanently.
    if (
      (termination.status === "terminated" ||
        termination.status === "already-gone") &&
      run.kind === "task" &&
      run.presetId !== null &&
      run.evaluation.status === "not_evaluated"
    ) {
      await saveAgentRun(storage, {
        ...run,
        evaluation: await evaluatePresetTaskRun(run, storage),
        updatedAt: now().toISOString(),
      });
    }
    const lock = await settleGroup(run, termination);
    const message =
      termination.status === "terminated" || termination.status === "already-gone"
        ? `The app restarted after this run's result was persisted; its worker process group is gone and post-result cleanup completed (lock ${lock}).`
        : terminationMessage(termination, run.runId);
    runs.push(toReport(run, termination, lock, message));
  }

  // Uncertain groups from earlier boots stay quarantined: retry them so the
  // paid lock remains a real barrier across restarts and is cleared only once
  // the group is proven gone.
  for (const entry of previous?.runs ?? []) {
    if (entry.outcome !== "skipped" && entry.outcome !== "escaped") continue;
    if (processed.has(entry.runId)) continue;
    let run: AgentRunRecord | undefined;
    try {
      run = await loadAgentRun(storage, entry.runId);
    } catch {
      // The record is unreadable; keep the unresolved entry and make sure the
      // paid barrier is held by a live process, not just a stale lock file.
      console.error(
        `[agent-recovery] Unresolved run ${entry.runId} still has an unreadable record; keeping its barrier entry.`,
      );
      const lock = await holdAgentLockForManualCleanup(storage, entry.runId);
      runs.push({
        ...entry,
        lock,
        message: boundedMessage(
          `The run record is unreadable. The paid barrier is held until the record is restored or the run's processes are cleaned up manually (lock ${lock}).`,
        ),
      });
      continue;
    }
    if (!run) {
      // A missing record is not proof that the recorded process group is gone.
      // Dropping the entry would erase the only persisted cleanup obligation,
      // so keep it and hold the barrier under this live process.
      console.error(
        `[agent-recovery] Unresolved run ${entry.runId} has no run record; keeping its barrier entry.`,
      );
      const lock = await holdAgentLockForManualCleanup(storage, entry.runId);
      runs.push({
        ...entry,
        lock,
        message: boundedMessage(
          `The run record is missing. The paid barrier is held until the record is restored or the run's processes are cleaned up manually (lock ${lock}).`,
        ),
      });
      continue;
    }
    if (isActiveAgentRunStatus(run.status)) continue;
    const termination = await inspect(run);
    const gone =
      termination.status === "terminated" ||
      termination.status === "already-gone";
    let evaluation = run.evaluation;
    if (
      gone &&
      run.kind === "task" &&
      run.presetId !== null &&
      run.evaluation.status === "not_evaluated"
    ) {
      // Persist the backfill before releasing the paid lock; the lock is the
      // durable pointer that lets a later boot retry if this write fails.
      evaluation = await evaluatePresetTaskRun(run, storage);
      await saveAgentRun(storage, {
        ...run,
        evaluation,
        updatedAt: now().toISOString(),
      });
    }
    const lock = await settleGroup(run, termination);
    const message = terminationMessage(termination, run.runId);
    if (gone) {
      const endedAt = now().toISOString();
      const updated: AgentRunRecord = {
        ...run,
        error:
          run.status === "completed"
            ? run.error
            : boundedMessage(
                `${run.error ?? "The run was interrupted."} Manual cleanup is no longer needed; the worker process group is gone.`,
              ),
        evaluation,
        updatedAt: endedAt,
      };
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
