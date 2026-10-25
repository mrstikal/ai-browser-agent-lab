import { Storage, StorageCorruptionError } from "./storage";

export const AGENT_COMPATIBILITY_SEGMENTS = ["agent-compatibility.json"] as const;
export const AGENT_COMPATIBILITY_VERSION = 1;

export type VisionEvidence = "observed" | "unverified";

export interface AgentCompatibilityRecord {
  readonly version: typeof AGENT_COMPATIBILITY_VERSION;
  readonly modelId: string;
  readonly sdkVersion: string;
  readonly origin: string;
  readonly verifiedAt: string;
  readonly vision: VisionEvidence;
  /**
   * Only a transport-instrumented visual smoke may set this. Without it, an
   * `observed` value from an older build is normalized to `unverified` on read.
   */
  readonly visionTransport?: true;
}

export class AgentCompatibilityError extends StorageCorruptionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentCompatibilityError";
  }
}

function corrupted(message: string): never {
  throw new AgentCompatibilityError(`Agent compatibility record is invalid: ${message}`);
}

export function parseAgentCompatibility(value: unknown): AgentCompatibilityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    corrupted("expected an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== AGENT_COMPATIBILITY_VERSION) {
    corrupted(`unsupported version ${String(record.version)}.`);
  }
  for (const field of ["modelId", "sdkVersion", "origin", "verifiedAt"] as const) {
    if (
      typeof record[field] !== "string" ||
      record[field].length === 0 ||
      record[field].length > 500
    ) {
      corrupted(`${field} must be a bounded string.`);
    }
  }
  if (
    !(record.modelId as string).startsWith("openrouter/") ||
    (record.modelId as string).split("/").length < 3
  ) {
    corrupted("modelId must be an OpenRouter browser model.");
  }
  if (Number.isNaN(Date.parse(record.verifiedAt as string))) {
    corrupted("verifiedAt must be an ISO timestamp.");
  }
  if (record.vision !== "observed" && record.vision !== "unverified") {
    corrupted("vision must be observed or unverified.");
  }
  const transportProven = record.visionTransport === true;
  if (
    record.visionTransport !== undefined &&
    record.visionTransport !== true
  ) {
    corrupted("visionTransport must be true when present.");
  }
  const parsed: AgentCompatibilityRecord = {
    version: AGENT_COMPATIBILITY_VERSION,
    modelId: record.modelId as string,
    sdkVersion: record.sdkVersion as string,
    origin: record.origin as string,
    verifiedAt: record.verifiedAt as string,
    // An `observed` label is only trusted when the writer recorded actual
    // transport proof. Older inference-based stamps therefore downgrade.
    vision:
      record.vision === "observed" && !transportProven
        ? "unverified"
        : record.vision,
  };
  return transportProven && parsed.vision === "observed"
    ? { ...parsed, visionTransport: true }
    : parsed;
}

export async function loadAgentCompatibility(
  storage: Storage,
): Promise<AgentCompatibilityRecord | undefined> {
  let raw: unknown;
  try {
    raw = await storage.readJson<unknown>(AGENT_COMPATIBILITY_SEGMENTS);
  } catch (error) {
    if (error instanceof StorageCorruptionError) {
      throw new AgentCompatibilityError(
        "The agent compatibility record contains malformed JSON. Inspect it manually.",
        { cause: error },
      );
    }
    throw error;
  }
  if (raw === undefined) return undefined;
  return parseAgentCompatibility(raw);
}

export async function saveAgentCompatibility(
  storage: Storage,
  record: AgentCompatibilityRecord,
): Promise<void> {
  await storage.writeJson(
    AGENT_COMPATIBILITY_SEGMENTS,
    parseAgentCompatibility(record),
  );
}

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
