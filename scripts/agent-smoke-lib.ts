export const AGENT_SMOKE_MAX_OBSERVATIONS = 2;
export const AGENT_SMOKE_LIMITS = {
  maxSteps: 8,
  timeoutMs: 120_000,
  maxCostUsd: 0.25,
} as const;

export type KeySource = "auto" | "app" | "tty";

export interface AgentSmokeArgs {
  readonly live: boolean;
  readonly approvePaid: boolean;
  readonly approvals: readonly number[];
  readonly headless: boolean;
  readonly help: boolean;
  readonly keySource: KeySource;
  readonly model: string | null;
}

export class AgentSmokeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSmokeUsageError";
  }
}

export function parseAgentSmokeArgs(argv: readonly string[]): AgentSmokeArgs {
  let live = false;
  let approvePaid = false;
  const approvals = new Set<number>();
  let headless = false;
  let help = false;
  let keySource: KeySource = "auto";
  let model: string | null = null;

  for (const arg of argv) {
    if (arg === "--live") live = true;
    else if (arg === "--approve-paid") approvePaid = true;
    else if (arg.startsWith("--approve-observation=")) {
      const value = arg.slice("--approve-observation=".length);
      if (value !== "1" && value !== "2") {
        throw new AgentSmokeUsageError(
          "--approve-observation must be 1 or 2; each observation is approved separately.",
        );
      }
      approvals.add(Number(value));
    } else if (arg === "--headless") headless = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--key-source=")) {
      const value = arg.slice("--key-source=".length);
      if (value !== "auto" && value !== "app" && value !== "tty") {
        throw new AgentSmokeUsageError("--key-source must be auto, app, or tty.");
      }
      keySource = value;
    } else if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (!value || value.length > 200) {
        throw new AgentSmokeUsageError("--model must be a bounded model ID.");
      }
      model = value;
    } else {
      throw new AgentSmokeUsageError(`Unknown argument: ${arg}`);
    }
  }

  return {
    live,
    approvePaid,
    approvals: [...approvals].sort(),
    headless,
    help,
    keySource,
    model,
  };
}

/**
 * Event-based evidence only: an image content part in a tool result. Token
 * counts or a correct DOM answer never prove screenshot input.
 */
export function containsImageContent(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsImageContent(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (record.type === "image") return true;
  if (Array.isArray(record.content)) {
    return containsImageContent(record.content, depth + 1);
  }
  return false;
}

export function redactText(text: string, secret?: string | null): string {
  let redacted = text;
  if (secret) redacted = redacted.split(secret).join("[redacted]");
  return redacted.replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]");
}

export function headingIsShop(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const heading = (output as Record<string, unknown>).heading;
  return typeof heading === "string" && heading.trim() === "Shop";
}

export interface StampEligibility {
  readonly headingOk: boolean;
  readonly domainPolicyBlocked: boolean;
  readonly keySource: KeySource;
  readonly usedRememberedKey: boolean;
  readonly modelMatchesSettings: boolean;
  readonly currentKeyStillMatches: boolean;
  readonly currentModelStillMatches: boolean;
}

export function canStampCompatibility(input: StampEligibility): boolean {
  return (
    input.headingOk &&
    input.domainPolicyBlocked &&
    input.keySource === "app" &&
    input.usedRememberedKey &&
    input.modelMatchesSettings &&
    input.currentKeyStillMatches &&
    input.currentModelStillMatches
  );
}
