import { Storage } from "./storage";

export const AGENT_COMPATIBILITY_SEGMENTS = ["agent-compatibility.json"] as const;

/**
 * Deletes the verified model/SDK/origin stamp, if present. Key replacement,
 * re-entry, and deletion must call this and succeed before changing the key so
 * a stale verification can never survive a credential change.
 */
export async function invalidateAgentCompatibility(
  storage: Storage,
): Promise<boolean> {
  return storage.deleteFile(AGENT_COMPATIBILITY_SEGMENTS);
}
