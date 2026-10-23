import { ensureServerLock } from "./server-lock";
import {
  recordImageRecoveryFailure,
  recoverInterruptedImageState,
} from "./image-recovery";
import { createStorage } from "./storage";

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

  // Startup recovery is local-only: it never contacts OpenRouter. Failures are
  // reported but must not prevent the server (and its status UI) from starting.
  try {
    const recovery = await recoverInterruptedImageState({
      storage: createStorage(),
    });
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
    await recordImageRecoveryFailure(createStorage(), message);
  }
}
