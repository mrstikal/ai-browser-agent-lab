import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent, BrowserUse, RunResult } from "@browser_use/pi";
import { containsImageContent, redactText } from "../lib/agent-output";
import {
  AGENT_WORKER_MAX_ERROR_CHARS,
  AGENT_WORKER_MAX_EVENTS,
  AGENT_WORKER_MAX_OUTPUT_CHARS,
  AGENT_WORKER_READY_MESSAGE,
  agentParentMessageSchema,
  agentRunStatusSchema,
  agentWorkerMessageSchema,
  type AgentRunStatus,
  type AgentStartMessage,
  type AgentWorkerEventKind,
  type AgentWorkerMessage,
  type AgentWorkerResultMessage,
  type AgentWorkerUsage,
} from "../lib/agent-ipc";
import { parseLoopbackOrigin } from "../server/config";
import { normalizeOpenRouterKey } from "../server/openrouter";
import { createStorage, type Storage } from "../server/storage";

/**
 * One-run agent worker. The supervisor spawns this file as a child process
 * with an IPC channel, passes the API key through the environment, and sends
 * exactly one validated `start` message. The worker creates its own dedicated
 * Chromium profile under `data/browser-profiles/<runId>/`, starts the task at
 * the trusted loopback URL carried by the message, normalizes SDK events into
 * bounded redacted IPC messages, and always closes the browser and removes the
 * disposable profile and workspace in `finally`.
 */

export const AGENT_WORKER_INSTRUCTIONS = [
  "Use only the configured local application at the URL given in the task.",
  "Never read source files, environment variables, credentials, or secrets.",
  "Never run shell commands.",
  "Do not navigate to external sites, make purchases, or call APIs directly.",
  "Interact with the page only through the visible browser UI.",
].join(" ");

interface NormalizedEvent {
  readonly kind: AgentWorkerEventKind;
  readonly toolName?: string | undefined;
  readonly isError?: boolean | undefined;
}

interface RunOutcome {
  readonly result: RunResult<unknown> | null;
  readonly thrown: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function boundedText(
  value: unknown,
  maxChars: number,
  secret: string | null,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const bounded = redactText(value, secret).slice(0, maxChars);
  return bounded.length > 0 ? bounded : undefined;
}

function normalizeSdkEvent(
  event: AgentEvent,
  secret: string | null,
): NormalizedEvent | null {
  const record = event as {
    type?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
  const toolName = boundedText(record.toolName, 120, secret);
  switch (record.type) {
    case "agent_start":
      return { kind: "agent_start" };
    case "agent_end":
      return { kind: "agent_end" };
    case "turn_start":
      return { kind: "turn_start" };
    case "turn_end":
      return { kind: "turn_end" };
    case "tool_execution_start":
      return { kind: "tool_start", toolName };
    case "tool_execution_end":
      return { kind: "tool_end", toolName, isError: record.isError === true };
    default:
      return null;
  }
}

async function runWorker(): Promise<number> {
  const logError = (message: string, secret: string | null): void => {
    process.stderr.write(`[agent-worker] ${redactText(message, secret)}\n`);
  };

  if (typeof process.send !== "function") {
    logError(
      "This worker must be started with a Node.js IPC channel (see src/worker/agent-runner.ts).",
      null,
    );
    return 1;
  }

  let storage: Storage;
  try {
    storage = createStorage(process.env);
  } catch (error) {
    logError(`Invalid worker data directory: ${messageOf(error)}`, null);
    return 1;
  }

  let key: string;
  try {
    key = normalizeOpenRouterKey(process.env.OPENROUTER_API_KEY ?? "");
  } catch {
    logError("The worker was started without a usable OpenRouter API key.", null);
    return 1;
  }

  const state = {
    phase: "waiting" as "waiting" | "running" | "finished",
    runId: null as string | null,
    cancelled: false,
    protocolViolation: false,
    sequence: 0,
    eventsEmitted: 0,
    imageInputObserved: false,
    controller: null as AbortController | null,
    agent: null as BrowserUse | null,
  };

  const channelIsClosed = (): boolean =>
    typeof process.send !== "function" || process.connected === false;

  const send = (message: AgentWorkerMessage): boolean => {
    const parsed = agentWorkerMessageSchema.safeParse(message);
    if (!parsed.success) {
      logError("Refused to send an invalid agent IPC message.", key);
      return false;
    }
    if (channelIsClosed()) return false;
    try {
      // A `false` return from process.send only means backpressure here; the
      // message is still queued, so a live channel is an accepted send.
      process.send?.(parsed.data);
      return true;
    } catch (error) {
      logError(`IPC send failed: ${messageOf(error)}`, key);
      return false;
    }
  };

  const sendFinal = (message: AgentWorkerMessage): Promise<boolean> => {
    const parsed = agentWorkerMessageSchema.safeParse(message);
    const payload: AgentWorkerMessage = parsed.success
      ? parsed.data
      : {
          type: "error",
          runId: state.runId,
          message: "The worker produced an invalid agent IPC message.",
        };
    return new Promise<boolean>((resolve) => {
      const failed = (detail: string) => {
        clearTimeout(timer);
        logError(`A terminal agent IPC message was not delivered: ${detail}`, key);
        resolve(false);
      };
      const timer = setTimeout(
        () => failed("the channel did not confirm the message in time."),
        5_000,
      );
      if (channelIsClosed()) {
        failed("the channel is closed.");
        return;
      }
      try {
        const callback = (error: Error | null) => {
          if (error) {
            failed(messageOf(error));
          } else {
            clearTimeout(timer);
            resolve(true);
          }
        };
        const queued = process.send?.(payload, callback);
        if (queued !== true && channelIsClosed()) {
          // Backpressure keeps the callback pending; a closed channel does not.
          failed("the channel refused the message.");
        }
      } catch (error) {
        failed(messageOf(error));
      }
    });
  };

  const finishWithError = async (
    runId: string | null,
    reason: string,
  ): Promise<number> => {
    const boundedReason =
      redactText(reason, key).slice(0, AGENT_WORKER_MAX_ERROR_CHARS) ||
      "The worker failed without a message.";
    logError(boundedReason, null);
    const message = state.protocolViolation
      ? "The worker stopped after an agent IPC protocol violation."
      : boundedReason;
    await sendFinal({ type: "error", runId, message });
    return 1;
  };

  const requestCancel = (): void => {
    if (state.cancelled) return;
    state.cancelled = true;
    state.controller?.abort();
    try {
      state.agent?.cancel();
    } catch (error) {
      logError(`The SDK cancel call failed: ${messageOf(error)}`, key);
    }
  };

  const emitEvent = (runId: string, event: AgentEvent): void => {
    const normalized = normalizeSdkEvent(event, key);
    if (!normalized) return;
    const raw = event as { result?: unknown };
    const imageContent =
      normalized.kind === "tool_end" && containsImageContent(raw.result);
    if (imageContent) state.imageInputObserved = true;
    if (state.eventsEmitted >= AGENT_WORKER_MAX_EVENTS) return;
    state.sequence += 1;
    state.eventsEmitted += 1;
    send({
      type: "event",
      runId,
      seq: state.sequence,
      at: new Date().toISOString(),
      ...normalized,
      ...(imageContent ? { imageContent: true } : {}),
    });
  };

  const usageFrom = (result: RunResult<unknown> | null): AgentWorkerUsage => {
    const usage =
      result && typeof result.usage === "object" && result.usage !== null
        ? (result.usage as unknown as Record<string, unknown>)
        : null;
    const cost =
      usage && typeof usage.cost === "object" && usage.cost !== null
        ? (usage.cost as Record<string, unknown>)
        : null;
    return {
      inputTokens: safeInt(usage?.input),
      outputTokens: safeInt(usage?.output),
      totalTokens: safeInt(usage?.totalTokens),
      estimatedCostUsd: safeNumber(cost?.total),
    };
  };

  const resultMessage = (
    runId: string,
    outcome: RunOutcome,
  ): AgentWorkerResultMessage => {
    const result = outcome.result;
    const parsedStatus = agentRunStatusSchema.safeParse(result?.status);
    const status: AgentRunStatus = parsedStatus.success
      ? parsedStatus.data
      : "error";
    const text = result && typeof result.text === "string" ? result.text : "";
    const rawError =
      result &&
      "error" in result &&
      typeof (result as { error?: unknown }).error === "string"
        ? ((result as { error?: string }).error ?? null)
        : null;
    return {
      type: "result",
      runId,
      status,
      outputText: redactText(text, key).slice(0, AGENT_WORKER_MAX_OUTPUT_CHARS),
      error:
        status === "completed"
          ? null
          : redactText(
              outcome.thrown ??
                rawError ??
                "The SDK run did not complete.",
              key,
            ).slice(0, AGENT_WORKER_MAX_ERROR_CHARS) ||
            "The SDK run did not complete.",
      steps: safeInt(result?.steps),
      durationMs: safeInt(result?.durationMs),
      usage: usageFrom(result),
      imageInputObserved: state.imageInputObserved,
    };
  };

  const loadSdk = async (): Promise<typeof import("@browser_use/pi")> => {
    const override = process.env.AGENT_WORKER_TEST_SDK;
    if (
      override &&
      (process.env.LAB_TEST_MODE !== "1" || !process.env.DATA_DIR?.trim())
    ) {
      throw new Error(
        "AGENT_WORKER_TEST_SDK requires LAB_TEST_MODE=1 and DATA_DIR; refusing a production SDK override.",
      );
    }
    return (override
      ? await import(override)
      : await import("@browser_use/pi")) as typeof import("@browser_use/pi");
  };

  const runTask = async (
    agent: BrowserUse,
    message: AgentStartMessage,
    signal: AbortSignal,
  ): Promise<RunOutcome> => {
    try {
      const result = await agent.run(message.task, {
        maxSteps: message.limits.maxSteps,
        timeoutMs: message.limits.timeoutMs,
        maxCostUsd: message.limits.maxCostUsd,
        signal,
        onEvent: (event: AgentEvent) => {
          emitEvent(message.runId, event);
        },
      });
      return { result: result as RunResult<unknown>, thrown: null };
    } catch (error) {
      return { result: null, thrown: messageOf(error) };
    }
  };

  const executeRun = async (message: AgentStartMessage): Promise<number> => {
    state.phase = "running";
    state.runId = message.runId;

    let config;
    try {
      config = parseLoopbackOrigin(message.startUrl, "The agent start URL");
    } catch (error) {
      return await finishWithError(message.runId, messageOf(error));
    }

    let profileDir: string | undefined;
    let workspace: string | undefined;
    try {
      try {
        profileDir = await storage.ensureDir(["browser-profiles", message.runId]);
        workspace = await mkdtemp(join(tmpdir(), "ai-browser-lab-agent-worker-"));
      } catch (error) {
        return await finishWithError(
          message.runId,
          `The worker could not prepare its isolated directories: ${messageOf(error)}`,
        );
      }

      let agent: BrowserUse;
      const controller = new AbortController();
      state.controller = controller;
      if (state.cancelled) controller.abort();
      try {
        const sdk = await loadSdk();
        agent = await sdk.BrowserUse.create({
          model: message.model,
          browser: sdk.Browser.chromium({
            headless: message.headless,
            profileDir,
          }),
          workspace,
          allowedDomains: [config.hostname],
          prohibitedDomains: [],
          telemetry: false,
          highlightActions: true,
          researchTools: false,
          log: false,
          maxOutputChars: AGENT_WORKER_MAX_OUTPUT_CHARS,
          redact: [key],
          instructions: AGENT_WORKER_INSTRUCTIONS,
        });
        state.agent = agent;
      } catch (error) {
        return await finishWithError(
          message.runId,
          `The agent browser could not be started: ${messageOf(error)}`,
        );
      }

      if (
        !send({
          type: "started",
          runId: message.runId,
          startedAt: new Date().toISOString(),
        })
      ) {
        return await finishWithError(
          message.runId,
          "The worker could not report its start over IPC.",
        );
      }

      const outcome = await runTask(agent, message, controller.signal);
      if (state.protocolViolation) {
        return await finishWithError(
          message.runId,
          "The worker aborted after an agent IPC protocol violation.",
        );
      }
      const delivered = await sendFinal(resultMessage(message.runId, outcome));
      if (!delivered) {
        logError(
          "The worker could not deliver its final result over IPC.",
          key,
        );
        return 1;
      }
      return 0;
    } finally {
      if (state.agent) {
        try {
          await state.agent.close();
        } catch (error) {
          logError(
            `The agent browser could not be closed cleanly: ${messageOf(error)}`,
            key,
          );
        }
      }
      if (workspace) {
        await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      }
      if (profileDir) {
        await rm(profileDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  };

  let resolveExit: (code: number) => void = () => undefined;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  process.on("message", (raw: unknown) => {
    const parsed = agentParentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      if (state.phase === "finished") return;
      state.protocolViolation = true;
      const violation =
        "The worker received a message that violates the agent IPC contract.";
      if (state.phase === "running") {
        logError(violation, key);
        requestCancel();
        return;
      }
      state.phase = "finished";
      void finishWithError(null, violation)
        .then((code) => resolveExit(code))
        .catch(() => resolveExit(1));
      return;
    }

    if (parsed.data.type === "cancel") {
      if (state.phase === "running") requestCancel();
      return;
    }

    if (state.phase !== "waiting") {
      if (state.phase === "finished") return;
      state.protocolViolation = true;
      logError(
        "The worker received a second start message while a task was still running.",
        key,
      );
      requestCancel();
      return;
    }

    const startRequest = parsed.data;
    void executeRun(startRequest)
      .then((code) => {
        state.phase = "finished";
        resolveExit(code);
      })
      .catch(async (error: unknown) => {
        state.phase = "finished";
        await finishWithError(
          startRequest.runId,
          `The worker failed unexpectedly: ${messageOf(error)}`,
        ).catch(() => undefined);
        resolveExit(1);
      });
  });

  if (!send(AGENT_WORKER_READY_MESSAGE)) {
    logError("The worker could not report readiness over IPC.", key);
    return 1;
  }

  return await exitPromise;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runWorker()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const secret = (process.env.OPENROUTER_API_KEY ?? "").trim();
      process.stderr.write(
        `[agent-worker] ${redactText(messageOf(error), secret || null)}\n`,
      );
      process.exit(1);
    });
}
