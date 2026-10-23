import { ensureServerLock } from "./server-lock";

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
}
