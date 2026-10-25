import { resolve } from "node:path";
import {
  AgentWorkerUnavailableError,
  readInstalledSdkVersion,
  startAgentRun,
  type AgentStartResult,
  type StartAgentRunOptions,
} from "./agent-manager";
import {
  invalidateAgentCompatibility,
  saveAgentCompatibility,
} from "./agent-compatibility";
import { loadAgentRun, saveAgentRun, type AgentRunRecord } from "./agent-runs";
import { resolveAppConfig } from "./config";
import { loadOpenRouterKey } from "./credentials";
import { loadModelSettings } from "./model-settings";
import { createStorage, type Storage, type StorageEnv } from "./storage";

/**
 * The one fixed, bounded browser job that can stamp the app. It reads the
 * stable `/shop` heading through the supervisor, so a model that cannot drive
 * the local browser cannot produce a matching answer.
 */
export const VERIFICATION_EXPECTED_HEADING = "Shop";
export const VERIFICATION_MAX_HEADING_CHARS = 200;

export interface AgentVerificationEvaluation {
  readonly status: "passed" | "failed";
  readonly reason: string;
}

export interface VerificationSettleOutcome {
  readonly evaluation: AgentVerificationEvaluation;
  readonly stamped: boolean;
  /** Why the stamp was skipped; null when stamped or when the answer failed. */
  readonly skipReason: string | null;
}

/**
 * Strict parse of the neutral answer shape. The task asks for exactly
 * `{"heading":"<visible text>"}`; wrapped prose, arrays, or extra invalid
 * heading values fail instead of being guessed.
 */
export function parseVerificationHeading(outputText: string | null): string | null {
  if (typeof outputText !== "string" || outputText.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const heading = (parsed as Record<string, unknown>).heading;
  if (typeof heading !== "string") return null;
  const trimmed = heading.trim();
  if (trimmed.length === 0 || trimmed.length > VERIFICATION_MAX_HEADING_CHARS) {
    return null;
  }
  return trimmed;
}

function isVerificationPage(
  finalUrl: string | null,
  origin: string,
): boolean {
  if (finalUrl === null) return false;
  try {
    const actual = new URL(finalUrl);
    const expected = new URL(origin);
    const path = actual.pathname.replace(/\/+$/, "") || "/";
    return actual.origin === expected.origin && path === "/shop";
  } catch {
    return false;
  }
}

export function evaluateVerificationRun(
  record: AgentRunRecord,
): AgentVerificationEvaluation {
  if (record.kind !== "verification") {
    return {
      status: "failed",
      reason: "Only the fixed verification run can confirm the browser model.",
    };
  }
  if (record.status !== "completed") {
    return {
      status: "failed",
      reason:
        record.error?.slice(0, 1_000) ??
        `The verification run ended as ${record.status} without a result.`,
    };
  }
  if (record.stopReason !== "completed") {
    return {
      status: "failed",
      reason: `The SDK stopped the verification run (${record.stopReason ?? "unknown"}).`,
    };
  }
  if (!isVerificationPage(record.finalUrl ?? null, record.origin)) {
    return {
      status: "failed",
      reason:
        "The verification run did not finish on the configured /shop page, so browser navigation was not observed.",
    };
  }
  const heading = parseVerificationHeading(record.outputText);
  if (heading === null) {
    return {
      status: "failed",
      reason:
        "The verification run did not return the required JSON heading answer.",
    };
  }
  if (heading !== VERIFICATION_EXPECTED_HEADING) {
    return {
      status: "failed",
      reason: `The model returned ${JSON.stringify(heading)} instead of ${JSON.stringify(VERIFICATION_EXPECTED_HEADING)}.`,
    };
  }
  return {
    status: "passed",
    reason: "The model read the Shop heading from the running app.",
  };
}

export interface VerificationSettlerOptions {
  readonly storage: Storage;
  readonly env: StorageEnv;
  readonly repoRoot: string;
  /** The server-side key captured before the run; a change must not stamp. */
  readonly keyBefore: string | undefined;
  readonly sdkVersionBefore: string | null;
  readonly now?: (() => Date) | undefined;
}

function evaluationReason(reason: string): string {
  return reason.slice(0, 1_000);
}

/**
 * Persists the deterministic evaluation once, at termination, so later form
 * resets or history reads never recompute it.
 */
async function persistEvaluation(
  options: VerificationSettlerOptions,
  record: AgentRunRecord,
  evaluation: AgentVerificationEvaluation,
): Promise<void> {
  const current = await loadAgentRun(options.storage, record.runId);
  if (!current || current.kind !== "verification") return;
  await saveAgentRun(options.storage, {
    ...current,
    evaluation: {
      status: evaluation.status,
      reason: evaluationReason(evaluation.reason),
    },
    updatedAt: (options.now?.() ?? new Date()).toISOString(),
  });
}

interface StampDecision {
  readonly stamped: boolean;
  readonly skipReason: string | null;
}

/**
 * The stamp is the tuple `model + installed SDK + configured origin` with the
 * observed vision evidence. Every component is re-read at settle time; a
 * change during the run (the setup wizard can still change the browser model)
 * or an unreadable state fails closed instead of stamping an unproven tuple.
 */
async function stampCurrentTuple(
  options: VerificationSettlerOptions,
  record: AgentRunRecord,
): Promise<StampDecision> {
  const settings = await loadModelSettings(options.storage);
  if (settings.browser.modelId !== record.modelId) {
    return {
      stamped: false,
      skipReason: "The browser model changed during verification.",
    };
  }
  const config = resolveAppConfig(options.env);
  if (config.origin !== record.origin) {
    return {
      stamped: false,
      skipReason: "The configured app origin changed during verification.",
    };
  }
  const sdkVersion = await readInstalledSdkVersion(options.repoRoot);
  if (
    options.sdkVersionBefore === null ||
    sdkVersion !== options.sdkVersionBefore
  ) {
    return {
      stamped: false,
      skipReason: "The installed browser SDK changed during verification.",
    };
  }
  const currentKey = await loadOpenRouterKey(options.env);
  if (!currentKey || currentKey !== options.keyBefore) {
    return {
      stamped: false,
      skipReason: "The OpenRouter key changed during verification.",
    };
  }

  await saveAgentCompatibility(options.storage, {
    version: 1,
    modelId: record.modelId,
    sdkVersion,
    origin: record.origin,
    verifiedAt: (options.now?.() ?? new Date()).toISOString(),
    vision: record.imageInputObserved ? "observed" : "unverified",
  });

  // A browser-model change invalidates the stamp before saving settings; a
  // stamp written in that window must not survive beside the new model.
  const after = await loadModelSettings(options.storage);
  if (after.browser.modelId !== record.modelId) {
    await invalidateAgentCompatibility(options.storage);
    return {
      stamped: false,
      skipReason: "The browser model changed while the stamp was saved.",
    };
  }
  return { stamped: true, skipReason: null };
}

/**
 * Called by the supervisor once a run has fully settled (terminal state
 * persisted, process group proven gone, paid lock still held). The paid lock
 * keeps in-app key changes out until the evaluation and stamp are durable.
 */
export function buildVerificationSettler(
  options: VerificationSettlerOptions,
): (record: AgentRunRecord) => Promise<VerificationSettleOutcome> {
  return async (record) => {
    const evaluation = evaluateVerificationRun(record);
    let evaluationPersisted = true;
    try {
      await persistEvaluation(options, record, evaluation);
    } catch (error) {
      evaluationPersisted = false;
      console.error(
        `[agent-verification] The verification evaluation of run ${record.runId} could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (evaluation.status !== "passed") {
      return { evaluation, stamped: false, skipReason: null };
    }
    if (!evaluationPersisted) {
      // A stamp without its persisted evaluation would make the dashboard
      // claim a verified model beside an unevaluated run.
      return {
        evaluation,
        stamped: false,
        skipReason: "The verification evaluation could not be persisted.",
      };
    }
    try {
      const decision = await stampCurrentTuple(options, record);
      if (decision.skipReason) {
        console.error(
          `[agent-verification] Run ${record.runId} passed but was not stamped: ${decision.skipReason}`,
        );
      }
      return { evaluation, ...decision };
    } catch (error) {
      const skipReason = `The compatibility record could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`[agent-verification] ${skipReason}`);
      return { evaluation, stamped: false, skipReason };
    }
  };
}

export interface VerifyAgentModelOptions {
  readonly env?: StorageEnv | undefined;
  readonly storage?: Storage | undefined;
  readonly repoRoot?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
}

export type VerifyAgentModelResult = AgentStartResult;

/**
 * Runs the fixed verification job through the supervisor with the app's
 * server-side key (session memory or remembered file), and stamps the tuple
 * only after the answer matches and the tuple is still current.
 */
export async function verifyAgentModel(
  options: VerifyAgentModelOptions = {},
): Promise<VerifyAgentModelResult> {
  const env = options.env ?? process.env;
  const storage = options.storage ?? createStorage(env);
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  // Capture the pre-run tuple before the paid operation starts. The settler
  // compares it with the state at settle time and refuses a stale stamp.
  const keyBefore = await loadOpenRouterKey(env);
  let sdkVersionBefore: string | null = null;
  try {
    sdkVersionBefore = await readInstalledSdkVersion(repoRoot);
  } catch (error) {
    if (!(error instanceof AgentWorkerUnavailableError)) throw error;
  }
  const settler = buildVerificationSettler({
    storage,
    env,
    repoRoot,
    keyBefore,
    sdkVersionBefore,
    now: options.now,
  });
  const startOptions: StartAgentRunOptions = {
    kind: "verification",
    env,
    storage,
    repoRoot,
    fetchImpl: options.fetchImpl,
    now: options.now,
    onSettled: settler,
  };
  return startAgentRun(startOptions);
}
