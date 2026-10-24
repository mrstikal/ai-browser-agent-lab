import {
  recoverInterruptedAgentState,
  recordAgentRecoveryFailure,
} from "./agent-recovery";
import { ensureServerLock } from "./server-lock";
import {
  recordImageRecoveryFailure,
  recoverInterruptedImageState,
} from "./image-recovery";
import { createStorage, type Storage } from "./storage";

export async function startServerLock(): Promise<void> {
  try {
    const lock = await ensureServerLock();
    console.log(
      `[ai-browser-agent-lab] server lock held (owner ${lock.ownerId}, pid ${lock.metadata.pid})`,
    );
  } catch (error) {
    console.error(
      `[ai-browser-agent-lab] cannot start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  await runStartupRecoveries(createStorage());
}

/**
 * Startup recovery, local-only and never contacting OpenRouter. Agent recovery
 * runs first: it verifies and terminates orphan worker groups (and keeps their
 * paid-lock barrier) before image recovery inspects the shared lock. Failures
 * are reported but must not prevent the server (and its status UI) from
 * starting.
 */
export async function runStartupRecoveries(storage: Storage): Promise<void> {
  // Agent recovery is local-only too: it verifies recorded worker process
  // groups before signaling them and never releases a lock early.
  try {
    const recovery = await recoverInterruptedAgentState({ storage });
    if (recovery.status === "reconciled") {
      const uncertain = recovery.runs.filter(
        (run) => run.outcome === "skipped" || run.outcome === "escaped",
      );
      console.log(
        `[ai-browser-agent-lab] agent recovery: ${recovery.runs.length} orphan run(s) reconciled${uncertain.length > 0 ? `, ${uncertain.length} need manual cleanup` : ""}`,
      );
      for (const run of uncertain) {
        console.error(
          `[ai-browser-agent-lab] agent run ${run.runId}: ${run.message}`,
        );
      }
    } else {
      console.log(
        "[ai-browser-agent-lab] agent recovery skipped: no active runs",
      );
    }
    if (recovery.corruptRuns > 0) {
      console.error(
        `[ai-browser-agent-lab] agent recovery found ${recovery.corruptRuns} unreadable run record(s); inspect data/agent-runs manually.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-browser-agent-lab] agent recovery failed: ${message}`);
    await recordAgentRecoveryFailure(storage, message);
  }

  // Startup recovery is local-only: it never contacts OpenRouter. Failures are
  // reported but must not prevent the server (and its status UI) from starting.
  try {
    const recovery = await recoverInterruptedImageState({ storage });
    if (recovery.status === "reconciled") {
      console.log(
        `[ai-browser-agent-lab] image recovery: ${recovery.reconciliation?.reconciled.length ?? 0} reconciled, ${
          recovery.reconciliation?.quarantined.length ?? 0
        } quarantined${recovery.jobMarked ? `, job ${recovery.jobMarked}` : ""}`,
      );
    } else {
      console.log(
        `[ai-browser-agent-lab] image recovery skipped: ${recovery.status}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-browser-agent-lab] image recovery failed: ${message}`);
    await recordImageRecoveryFailure(storage, message);
  }
}
