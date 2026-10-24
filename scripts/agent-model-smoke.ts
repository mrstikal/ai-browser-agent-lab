import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent, BrowserUse, RunResult } from "@browser_use/pi";
import { modelIdSchema } from "../src/lib/schemas";
import { HEALTH_MARKER } from "../src/lib/health";
import {
  AGENT_SMOKE_LIMITS,
  AGENT_SMOKE_MAX_OBSERVATIONS,
  canStampCompatibility,
  containsImageContent,
  headingIsShop,
  parseAgentSmokeArgs,
  redactText,
  type AgentSmokeArgs,
  type KeySource,
} from "./agent-smoke-lib";
import { saveAgentCompatibility } from "../src/server/agent-compatibility";
import { resolveAppConfig } from "../src/server/config";
import {
  acquireLock,
  LockHeldError,
  LockError,
  type OwnerLock,
} from "../src/server/lock";
import {
  createDefaultModelSettings,
  loadModelSettings,
} from "../src/server/model-settings";
import { normalizeOpenRouterKey } from "../src/server/openrouter";
import { createStorage, type Storage } from "../src/server/storage";
import { nodeVersionProblem } from "./node-version.mjs";
import { assertDisplay, withLaunchGuidance } from "./browser-launch";

const APP_LOCK_SEGMENTS = ["locks", "paid-job.lock"] as const;
const APP_LOCK_KIND = "paid-job";

interface ObservationSummary {
  readonly attempt: number;
  readonly status: string;
  readonly heading: string | null;
  readonly headingOk: boolean;
  readonly steps: number | null;
  readonly durationMs: number | null;
  readonly tokens: {
    readonly input: number | null;
    readonly output: number | null;
    readonly total: number | null;
  };
  readonly estimatedCostUsd: number | null;
  readonly toolCalls: number;
  readonly imageContentSeen: boolean;
  readonly error: string | null;
}

interface SmokeResult {
  readonly status: "Verified" | "Partial - Unverified" | "Blocked";
  readonly reason: string;
  readonly sdk: "@browser_use/pi";
  readonly sdkVersion: string;
  readonly model: string;
  readonly origin: string;
  readonly keySource: KeySource;
  readonly usedRememberedKey: boolean;
  readonly keyAvailable: boolean;
  readonly paidObservations: number;
  readonly maxObservations: number;
  readonly limits: typeof AGENT_SMOKE_LIMITS;
  readonly vision: "observed" | "unverified";
  readonly domainPolicy: "blocked" | "not-blocked" | "unverified";
  readonly stampWritten: boolean;
  readonly appHealth: "ok" | "unreachable";
  readonly observations: readonly ObservationSummary[];
}

async function installedSdkVersion(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.resolve("@browser_use/pi")));
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (
        manifest.name === "@browser_use/pi" &&
        typeof manifest.version === "string"
      ) {
        return manifest.version;
      }
    } catch {
      // Keep walking toward the package root.
    }
    directory = dirname(directory);
  }
  throw new Error("Could not locate installed @browser_use/pi package metadata.");
}

function helpText(): string {
  return [
    "Authorized Browser Use Pi model smoke (billable only with explicit flags).",
    "",
    "  npm run test:agent -- [--live] [--approve-paid] [--approve-observation=1|2]",
    "                       [--headless] [--key-source=auto|app|tty] [--model=provider/model]",
    "",
    "Default (no --live): health + key/consent preflight only; zero paid calls.",
    "--live --approve-paid: run at most two separately approved observations of",
    "the running app's /shop h1 (Shop) using the configured APP_ORIGIN.",
    "--approve-observation=N: approve exactly observation N (repeat for 1 and 2).",
    "Without it, each observation needs an interactive yes.",
    "--key-source=app: use data/secrets/openrouter-key and allow stamping.",
    "--key-source=tty: hidden TTY prompt for SDK research; never stamps the app.",
    "",
    `Limits per observation: maxSteps ${AGENT_SMOKE_LIMITS.maxSteps}, timeout ${AGENT_SMOKE_LIMITS.timeoutMs} ms, soft cost $${AGENT_SMOKE_LIMITS.maxCostUsd}.`,
    "The app stamp is written only after a successful Shop-heading observation",
    "with the app's current remembered key and matching model/SDK/origin.",
    "Screenshots are labeled vision=observed only when SDK tool events actually",
    "carry image content; a correct heading alone is never vision evidence.",
  ].join("\n");
}

async function readRememberedKey(storage: Storage): Promise<string | null> {
  const bytes = await storage.readFile(["secrets", "openrouter-key"]);
  if (!bytes) return null;
  const key = bytes.toString("utf8").trim();
  return key.length > 0 ? key : null;
}

async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY is available for a hidden key prompt.");
  }
  process.stdout.write(prompt);
  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function confirmObservation(
  args: AgentSmokeArgs,
  origin: string,
  attempt: number,
): Promise<boolean> {
  if (args.approvals.includes(attempt)) return true;
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      `Observation ${attempt}/${AGENT_SMOKE_MAX_OBSERVATIONS}: navigating ${origin}/shop may incur OpenRouter charges. Type "yes" to proceed: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

async function checkHealth(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 200) return false;
    const body = (await response.json()) as { ok?: unknown; app?: unknown };
    return body.ok === true && body.app === HEALTH_MARKER;
  } catch {
    return false;
  }
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function observationFrom(
  attempt: number,
  result: RunResult<{ heading: string }>,
  toolCalls: number,
  imageContentSeen: boolean,
  secret: string,
): ObservationSummary {
  const completed = result.status === "completed";
  const usage =
    typeof result.usage === "object" && result.usage !== null
      ? (result.usage as {
          input?: unknown;
          output?: unknown;
          totalTokens?: unknown;
          cost?: { total?: unknown };
        })
      : undefined;
  return {
    attempt,
    status: result.status,
    heading: completed ? result.output.heading : null,
    headingOk: completed && headingIsShop(result.output),
    steps: safeNumber(result.steps),
    durationMs: safeNumber(result.durationMs),
    tokens: {
      input: safeNumber(usage?.input),
      output: safeNumber(usage?.output),
      total: safeNumber(usage?.totalTokens),
    },
    estimatedCostUsd: safeNumber(usage?.cost?.total),
    toolCalls,
    imageContentSeen,
    error:
      result.status === "completed"
        ? null
        : typeof result.error === "string"
          ? redactText(result.error, secret).slice(0, 500)
          : "The SDK run did not complete.",
  };
}

function isBlockedFailure(message: string): boolean {
  return /unsupported model|model[^\n]*(not found|not available|no access|access denied)|not support(ed)? (images?|vision)|vision[^\n]*(unsupported|not supported)|domain policy|Chrome not found|Chrome exited|did not expose CDP|Cannot find package|ERR_MODULE_NOT_FOUND|AGENT_SMOKE_TEST_SDK/i.test(
    message,
  );
}

async function main(): Promise<number> {
  const nodeProblem = nodeVersionProblem();
  if (nodeProblem) {
    console.error(nodeProblem);
    return 1;
  }

  let args: AgentSmokeArgs;
  try {
    args = parseAgentSmokeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (args.help) {
    console.log(helpText());
    return 0;
  }

  const headless =
    args.headless || process.env.SMOKE_HEADLESS === "1";
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  const sdkVersion = await installedSdkVersion();

  let config;
  try {
    config = resolveAppConfig(env);
  } catch (error) {
    console.error(
      `Blocked: APP_ORIGIN is not a valid loopback origin (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
    return 1;
  }
  const origin = config.origin;

  if (!(await checkHealth(origin))) {
    console.error(
      `Blocked: ${origin}/api/health did not return the app marker. Start the app at its configured origin and retry.`,
    );
    return 1;
  }

  const storage = createStorage(env);
  let settings;
  let settingsReadable = true;
  try {
    settings = await loadModelSettings(storage);
  } catch {
    settings = createDefaultModelSettings();
    settingsReadable = false;
  }
  const model = args.model ?? settings.browser.modelId;
  if (!modelIdSchema.safeParse(model).success) {
    console.error("Blocked: the selected browser model ID is not valid.");
    return 1;
  }
  const modelMatchesSettings = settingsReadable && model === settings.browser.modelId;

  const rememberedKey = await readRememberedKey(storage).catch(() => null);
  let source: KeySource = args.keySource;
  if (source === "auto") {
    source = rememberedKey ? "app" : process.stdin.isTTY ? "tty" : "auto";
  }

  let key: string | null = null;
  if (source === "app") {
    key = rememberedKey;
  } else if (source === "tty" && args.live && process.stdin.isTTY) {
    try {
      key = await promptHidden("OpenRouter API key (hidden): ");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  let malformedKey = false;
  if (key !== null) {
    try {
      key = normalizeOpenRouterKey(key);
    } catch {
      malformedKey = true;
      key = null;
    }
  }
  const usedRememberedKey = source === "app" && key !== null && key === rememberedKey;

  const baseResult = {
    sdk: "@browser_use/pi" as const,
    sdkVersion,
    model,
    origin,
    keySource: source,
    usedRememberedKey,
    keyAvailable: key !== null,
    maxObservations: AGENT_SMOKE_MAX_OBSERVATIONS,
    limits: AGENT_SMOKE_LIMITS,
    appHealth: "ok" as const,
  };

  const emit = (result: SmokeResult) => {
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
  };

  if (malformedKey) {
    emit({
      ...baseResult,
      status: "Partial - Unverified",
      reason:
        "The selected OpenRouter key format is not acceptable. No paid calls were made.",
      paidObservations: 0,
      vision: "unverified",
      domainPolicy: "unverified",
      stampWritten: false,
      observations: [],
    });
    return 1;
  }

  if (!args.live) {
    emit({
      ...baseResult,
      status: "Partial - Unverified",
      reason:
        "Live observation not requested (pass --live --approve-paid). No paid calls were made.",
      paidObservations: 0,
      vision: "unverified",
      domainPolicy: "unverified",
      stampWritten: false,
      observations: [],
    });
    return 0;
  }
  if (!args.approvePaid) {
    emit({
      ...baseResult,
      status: "Partial - Unverified",
      reason:
        "Paid observation was not approved (pass --approve-paid). No paid calls were made.",
      paidObservations: 0,
      vision: "unverified",
      domainPolicy: "unverified",
      stampWritten: false,
      observations: [],
    });
    return 0;
  }
  if (!key) {
    emit({
      ...baseResult,
      status: "Partial - Unverified",
      reason:
        "No key was available. Use Remember on in the app or a TTY research key; no paid calls were made.",
      paidObservations: 0,
      vision: "unverified",
      domainPolicy: "unverified",
      stampWritten: false,
      observations: [],
    });
    return 0;
  }

  if (!headless) {
    try {
      assertDisplay({ headless });
    } catch (error) {
      emit({
        ...baseResult,
        status: "Blocked",
        reason: error instanceof Error ? error.message : String(error),
        paidObservations: 0,
        vision: "unverified",
        domainPolicy: "unverified",
        stampWritten: false,
        observations: [],
      });
      return 1;
    }
  }

  let lock: OwnerLock | undefined;
  let workspace: string | undefined;
  let agent: BrowserUse | undefined;
  const observations: ObservationSummary[] = [];
  let successfulObservationVision = false;
  let domainPolicy: SmokeResult["domainPolicy"] = "unverified";
  let stampWritten = false;
  let status: SmokeResult["status"] = "Partial - Unverified";
  let reason = "No observation completed.";
  let paidObservations = 0;
  let blocked = false;
  const previousKey = process.env.OPENROUTER_API_KEY;

  try {
    lock = await acquireLock(storage, APP_LOCK_SEGMENTS, {
      kind: APP_LOCK_KIND,
      ownerId: `agent-smoke-${randomUUID()}`,
      releaseOnExit: true,
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      emit({
        ...baseResult,
        status: "Blocked",
        reason:
          "The shared paid-job lock is held by another operation. No paid calls were made.",
        paidObservations: 0,
        vision: "unverified",
        domainPolicy: "unverified",
        stampWritten: false,
        observations: [],
      });
      return 1;
    }
    if (error instanceof LockError) {
      console.error(`Blocked: ${error.message}`);
      return 1;
    }
    throw error;
  }

  try {
    const testSdk = process.env.AGENT_SMOKE_TEST_SDK;
    if (testSdk && (process.env.LAB_TEST_MODE !== "1" || !process.env.DATA_DIR)) {
      throw new Error(
        "AGENT_SMOKE_TEST_SDK requires LAB_TEST_MODE=1 and DATA_DIR; refusing a production SDK override.",
      );
    }
    const sdk = (testSdk
      ? await import(testSdk)
      : await import("@browser_use/pi")) as typeof import("@browser_use/pi");
    const { Browser, BrowserUse, Type } = sdk;
    workspace = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-smoke-"));
    process.env.OPENROUTER_API_KEY = key;
    const activeAgent = await BrowserUse.create({
      model,
      browser: Browser.chromium({ headless }),
      workspace,
      allowedDomains: [new URL(origin).hostname],
      prohibitedDomains: [],
      telemetry: false,
      highlightActions: true,
      researchTools: false,
      log: false,
      maxOutputChars: 20_000,
      instructions:
        "Use only the configured local application. Never read files, shell commands, credentials, or external sites. Do not make purchases or API calls.",
    });
    agent = activeAgent;

    const task = [
      `Open ${origin}/shop using only the local UI.`,
      "Read the page's main visible heading (the h1 text).",
      'Return JSON exactly matching {"heading": string}; do not guess.',
      "Do not navigate to any other host.",
    ].join("\n");
    const schema = Type.Object(
      { heading: Type.String({ minLength: 1, maxLength: 200 }) },
      { additionalProperties: false },
    );

    for (let attempt = 1; attempt <= AGENT_SMOKE_MAX_OBSERVATIONS; attempt += 1) {
      const approved = await confirmObservation(args, origin, attempt);
      if (!approved) {
        reason = "Paid observation approval was declined or unavailable.";
        break;
      }
      let toolCalls = 0;
      let attemptImages = false;
      let result: RunResult<{ heading: string }>;
      try {
        result = await activeAgent.run(task, {
          ...AGENT_SMOKE_LIMITS,
          schema,
          onEvent: (event: AgentEvent) => {
            if (event.type === "tool_execution_end") {
              toolCalls += 1;
              if (containsImageContent(event.result)) {
                attemptImages = true;
              }
            }
          },
        });
      } catch (error) {
        paidObservations += 1;
        const message = error instanceof Error ? error.message : String(error);
        observations.push({
          attempt,
          status: "error",
          heading: null,
          headingOk: false,
          steps: null,
          durationMs: null,
          tokens: { input: null, output: null, total: null },
          estimatedCostUsd: null,
          toolCalls,
          imageContentSeen: attemptImages,
          error: redactText(message, key).slice(0, 500),
        });
        reason = "The SDK observation failed.";
        if (isBlockedFailure(message)) {
          blocked = true;
          reason = redactText(message, key).slice(0, 500);
          break;
        }
        continue;
      }

      paidObservations += 1;
      const observation = observationFrom(
        attempt,
        result,
        toolCalls,
        attemptImages,
        key,
      );
      observations.push(observation);
      if (observation.headingOk) {
        successfulObservationVision = observation.imageContentSeen;
        reason = "The model read the Shop heading from the running app.";
        break;
      }
      reason = `Observation did not return the Shop heading (${result.status}).`;
      if (result.status !== "completed" && isBlockedFailure(result.error ?? "")) {
        blocked = true;
        reason = redactText(result.error ?? reason, key).slice(0, 500);
        break;
      }
    }

    try {
      await activeAgent.execute('await page.goto("http://example.invalid/")', {
        timeoutMs: 5000,
      });
      domainPolicy = "not-blocked";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      domainPolicy = /domain policy|navigation blocked/i.test(message)
        ? "blocked"
        : "unverified";
    }

    const headingOk = observations.some((observation) => observation.headingOk);
    if (domainPolicy === "not-blocked") {
      blocked = true;
      reason = "The SDK did not enforce the configured allowedDomains navigation policy.";
    }

    let currentKeyMatches = false;
    let currentModelMatches = false;
    try {
      const currentKey = await readRememberedKey(storage);
      currentKeyMatches = currentKey !== null && currentKey === key;
      const currentSettings = await loadModelSettings(storage);
      currentModelMatches = currentSettings.browser.modelId === model;
    } catch {
      currentKeyMatches = false;
      currentModelMatches = false;
    }

    if (
      !blocked &&
      canStampCompatibility({
        headingOk,
        domainPolicyBlocked: domainPolicy === "blocked",
        keySource: source,
        usedRememberedKey,
        modelMatchesSettings,
        currentKeyStillMatches: currentKeyMatches,
        currentModelStillMatches: currentModelMatches,
      })
    ) {
      await saveAgentCompatibility(storage, {
        version: 1,
        modelId: model,
        sdkVersion,
        origin,
        verifiedAt: new Date().toISOString(),
        vision: successfulObservationVision ? "observed" : "unverified",
      });
      stampWritten = true;
      status = "Verified";
      reason =
        "The live heading observation succeeded with the app's current remembered key.";
    } else if (blocked) {
      status = "Blocked";
    } else if (headingOk) {
      status = "Partial - Unverified";
      if (!usedRememberedKey) {
        reason =
          "The SDK observation succeeded, but it used a TTY key so the app was not stamped.";
      } else if (!modelMatchesSettings) {
        reason =
          "The SDK observation succeeded, but the model differs from the app's current browser model, so the app was not stamped.";
      } else if (!currentKeyMatches) {
        reason =
          "The remembered key changed during the smoke, so the app was not stamped.";
      } else if (domainPolicy !== "blocked") {
        reason =
          "The SDK observation succeeded, but domain-policy enforcement could not be verified.";
      }
    }
  } catch (error) {
    const guided = withLaunchGuidance(error, { headless });
    const message = guided.message;
    status = isBlockedFailure(message) ? "Blocked" : "Partial - Unverified";
    reason = redactText(message, key).slice(0, 1000);
  } finally {
    if (agent) {
      await agent.close().catch(() => undefined);
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (lock) {
      await lock.release().catch(() => undefined);
    }
  }

  emit({
    ...baseResult,
    status,
    reason,
    paidObservations,
    vision: successfulObservationVision ? "observed" : "unverified",
    domainPolicy,
    stampWritten,
    observations,
  });
  return status === "Blocked" ? 1 : 0;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
