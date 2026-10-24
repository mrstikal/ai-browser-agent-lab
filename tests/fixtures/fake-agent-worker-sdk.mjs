import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic SDK substitute for isolated agent worker tests. It records
 * what the worker handed to the SDK as JSON markers so tests can assert the
 * dedicated profile, disabled optional tools/telemetry, limits, and cleanup
 * without launching Chromium. Accepted only with LAB_TEST_MODE=1 and DATA_DIR.
 */

const mode = process.env.AGENT_WORKER_FAKE_MODE ?? "success";
const markersDir = process.env.AGENT_WORKER_TEST_MARKERS;

function mark(name, data) {
  if (!markersDir) return;
  mkdirSync(markersDir, { recursive: true });
  writeFileSync(join(markersDir, name), JSON.stringify(data ?? null));
}

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

let lastOptions = null;
let closeCount = 0;
let cancelCount = 0;

export const Browser = {
  chromium: (options) => ({ kind: "chromium", ...options }),
};

const agent = {
  async run(task, options = {}) {
    mark("run.json", {
      task,
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      maxCostUsd: options.maxCostUsd,
      hasSignal: options.signal instanceof AbortSignal,
    });
    if (mode === "failure") {
      return {
        status: "error",
        text: "",
        error: `Provider rejected the request with key ${process.env.OPENROUTER_API_KEY ?? ""}`,
        steps: 2,
        durationMs: 5,
        usage,
        workspace: "",
      };
    }
    if (mode === "throw") {
      throw new Error(`The SDK crashed with ${process.env.OPENROUTER_API_KEY ?? ""}`);
    }
    if (mode === "hang") {
      return await new Promise((resolve) => {
        // A short delay after the abort keeps the supervisor's `cancelling`
        // state observable before the terminal message arrives.
        const finish = () =>
          setTimeout(
            () =>
              resolve({
                status: "cancelled",
                text: "cancelled by the supervisor",
                steps: 1,
                durationMs: 25,
                usage,
                workspace: "",
              }),
            150,
          );
        if (options.signal?.aborted) finish();
        else options.signal?.addEventListener("abort", finish, { once: true });
      });
    }
    if (mode === "hang-forever") {
      // Ignores the abort signal entirely: the supervisor watchdog must mark
      // this run for forced cleanup instead of unlocking or completing it.
      await new Promise(() => {});
    }
    if (mode === "timeout") {
      return {
        status: "timeout",
        text: "",
        error: "The SDK run hit its wall-clock timeout.",
        steps: 1,
        durationMs: 40,
        usage,
        workspace: "",
      };
    }
    if (mode === "wait-for-disconnect") {
      const deadline = Date.now() + 10_000;
      while (process.connected) {
        if (Date.now() > deadline) {
          throw new Error("The IPC channel was never disconnected.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        status: "completed",
        output: { heading: "Shop" },
        text: '{"heading":"Shop"}',
        steps: 1,
        durationMs: 15,
        usage,
        workspace: "",
      };
    }
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (mode === "flood") {
      for (let index = 0; index < 1100; index += 1) {
        options.onEvent?.({
          type: "tool_execution_start",
          toolCallId: `call-${index}`,
          toolName: "javascript",
          args: {},
        });
      }
      return {
        status: "completed",
        output: { heading: "Shop" },
        text: '{"heading":"Shop"}',
        steps: 1,
        durationMs: 1,
        usage,
        workspace: "",
      };
    }

    options.onEvent?.({ type: "agent_start" });
    options.onEvent?.({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "javascript",
      args: {},
    });
    options.onEvent?.({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "javascript",
      isError: false,
      result: {
        content: [
          { type: "text", text: "Read the heading." },
          ...(mode === "vision"
            ? [{ type: "image", data: "", mimeType: "image/png" }]
            : []),
        ],
      },
    });
    options.onEvent?.({ type: "turn_end", message: {}, toolResults: [] });
    options.onEvent?.({ type: "agent_end", messages: [] });
    return {
      status: "completed",
      output: { heading: "Shop" },
      text: '{"heading":"Shop"}',
      steps: 3,
      durationMs: 25,
      usage,
      workspace: "",
    };
  },
  async execute() {
    return {};
  },
  cancel() {
    cancelCount += 1;
    mark("cancel.json", { cancelCount });
  },
  async close() {
    closeCount += 1;
    const profileDir = lastOptions?.browser?.profileDir ?? null;
    mark("close.json", {
      count: closeCount,
      profileDir,
      profileExistsAtClose:
        typeof profileDir === "string" && existsSync(profileDir),
    });
  },
};

export const BrowserUse = {
  create: async (options) => {
    mark("create.json", {
      model: options.model,
      telemetry: options.telemetry,
      highlightActions: options.highlightActions,
      researchTools: options.researchTools,
      log: options.log,
      allowedDomains: options.allowedDomains,
      prohibitedDomains: options.prohibitedDomains,
      redactCount: Array.isArray(options.redact) ? options.redact.length : null,
      redactedSecretMatches: (options.redact ?? []).includes(
        process.env.OPENROUTER_API_KEY,
      ),
      profileDir: options.browser?.profileDir ?? null,
      headless: options.browser?.headless ?? null,
      workspace: options.workspace ?? null,
      maxOutputChars: options.maxOutputChars ?? null,
      instructions: options.instructions ?? null,
    });
    if (mode === "launch-failure") {
      throw new Error("Chrome exited before exposing CDP.");
    }
    lastOptions = options;
    return agent;
  },
};
