import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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

function catalogAnswerFor(task) {
  if (typeof task !== "string") return null;
  if (task.includes("cheapest currently available product in the Home category")) {
    return {
      name: "Pebble Plant Pot",
      priceUsd: 22,
      url: "/shop/products/pebble-plant-pot",
    };
  }
  if (task.includes("names of all out-of-stock products")) {
    return {
      names: [
        "Atlas Travel Backpack",
        "Pulse Sport Earbuds",
        "Glow Aroma Diffuser",
        "Aero Laptop Stand",
      ],
      count: 4,
    };
  }
  if (task.includes("in-stock Audio product priced below $70")) {
    return {
      items: [
        { name: "Mini Bluetooth Radio", priceUsd: 44 },
        { name: "Echo Mini Speaker", priceUsd: 59 },
      ],
    };
  }
  return null;
}

function formTaskFor(task) {
  if (typeof task !== "string") return null;
  if (task.includes("Using the support form, submit name Alex Demo")) {
    return "support";
  }
  if (task.includes("Find Clarity Webcam and use its inquiry form")) {
    return "inquiry";
  }
  return null;
}

function submissionsDir(form) {
  const dataDir = process.env.DATA_DIR;
  return dataDir ? join(dataDir, "submissions", form) : null;
}

function existingSubmissionIds(form) {
  const dir = submissionsDir(form);
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function writeSubmission(form, overrides = {}) {
  const dir = submissionsDir(form);
  const id = randomUUID();
  if (!dir) return id;
  const createdAt = new Date().toISOString();
  const base =
    form === "support"
      ? {
          version: 1,
          id,
          createdAt,
          requestId: id,
          fullName: "Alex Demo",
          email: "alex@example.com",
          subject: "Payment confirmation issue",
          priority: "High",
          description:
            "I did not receive a confirmation after the simulated payment.",
          confirmLocalTest: true,
        }
      : {
          version: 1,
          id,
          createdAt,
          requestId: id,
          fullName: "Alex Demo",
          email: "alex@example.com",
          productId: "P22",
          inquiryType: "Specifications",
          message: "Does this webcam support 1080p video recording?",
        };
  const record = { ...base, ...overrides };
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return id;
}

function formTaskAnswer(form) {
  if (mode === "form-old-id") {
    const id = existingSubmissionIds(form)[0] ?? randomUUID();
    return form === "support" ? { requestId: id } : { confirmationId: id };
  }
  if (mode === "form-wrong-id") {
    writeSubmission(form);
    const id = randomUUID();
    return form === "support" ? { requestId: id } : { confirmationId: id };
  }
  if (mode === "form-duplicate") {
    const id = writeSubmission(form);
    writeSubmission(form);
    return form === "support" ? { requestId: id } : { confirmationId: id };
  }
  if (mode === "form-incorrect-field") {
    const id =
      form === "support"
        ? writeSubmission("support", { priority: "Low" })
        : writeSubmission("inquiry", { inquiryType: "Other" });
    return form === "support" ? { requestId: id } : { confirmationId: id };
  }
  if (mode === "form-no-record") {
    const id = randomUUID();
    return form === "support" ? { requestId: id } : { confirmationId: id };
  }
  const id = writeSubmission(form);
  return form === "support" ? { requestId: id } : { confirmationId: id };
}

function emitStandardEvents(options, task) {
  options.onEvent?.({ type: "agent_start" });
  const toolName =
    typeof task === "string" && task.includes("[[xss]]")
      ? '<img src=x onerror="alert(1)">'
      : "javascript";
  options.onEvent?.({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName,
    args: {},
  });
  options.onEvent?.({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName,
    isError: false,
    result: {
      content: [
        { type: "text", text: "Read the heading." },
        ...(mode === "vision" || mode === "vision-no-followup"
          ? [{ type: "image", data: "", mimeType: "image/png" }]
          : []),
      ],
    },
  });
  if (mode !== "javascript-no-action") sawBrowserTool = true;
  options.onEvent?.({ type: "turn_end", message: {}, toolResults: [] });
  if (mode === "vision") {
    // A follow-up model request is what turns a tool image into model input.
    options.onEvent?.({ type: "turn_start", turn: 2 });
  }
  options.onEvent?.({ type: "agent_end", messages: [] });
}

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

const headingAnswer =
  mode === "wrong-heading"
    ? { output: { heading: "Storefront" }, text: '{"heading":"Storefront"}' }
    : mode === "malformed-output"
      ? { output: null, text: "The heading is Shop." }
      : { output: { heading: "Shop" }, text: '{"heading":"Shop"}' };

let lastOptions = null;
let closeCount = 0;
let cancelCount = 0;
let currentTask = null;
let sawBrowserTool = false;

function attachRecording(result) {
  if (
    !sawBrowserTool &&
    mode !== "error-recording" &&
    mode !== "incomplete-recording"
  ) {
    return result;
  }
  if (!result || typeof result !== "object") return result;
  const workspace = lastOptions?.workspace;
  if (typeof workspace !== "string") return result;
  const recordingPath = join(workspace, "fake-recording.json");
  writeFileSync(
    recordingPath,
    JSON.stringify({
      version: 1,
      task: currentTask,
      frames: [
        { label: "Browser" },
        ...(sawBrowserTool
          ? [{ label: "Navigate" }, { label: "Click" }]
          : []),
        { label: typeof result.status === "string" ? result.status : "completed" },
      ],
      status: "completed",
      warnings: [],
      capped: false,
    }),
  );
  return { ...result, recordingPath };
}

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
    if (mode === "error-recording" || mode === "incomplete-recording") {
      return {
        status: mode === "error-recording" ? "error" : "incomplete",
        text: "",
        error: "The run failed after the recorder started.",
        steps: 2,
        durationMs: 5,
        usage,
        workspace: "",
      };
    }
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
    if (
      mode === "grandchild-orphan-owned" ||
      mode === "grandchild-orphan-unowned"
    ) {
      // The worker dies hard (no SDK result, no finally cleanup) leaving the
      // grandchild in its process group.
      const profileDir = lastOptions?.browser?.profileDir ?? null;
      const argv0 =
        mode === "grandchild-orphan-owned" && profileDir
          ? `--user-data-dir=${profileDir}`
          : "agent-worker-grandchild";
      const grandchild = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { argv0, stdio: "ignore" },
      );
      grandchild.unref();
      mark("grandchild.json", { pid: grandchild.pid ?? null, argv0 });
      process.exit(0);
    }
    if (mode === "grandchild-hang" || mode === "grandchild-hang-no-term") {
      if (mode === "grandchild-hang-no-term") {
        // The worker survives SIGTERM so forced cleanup must escalate.
        process.on("SIGTERM", () => {});
      }
      const profileDir = lastOptions?.browser?.profileDir ?? null;
      const argv0 = profileDir
        ? `--user-data-dir=${profileDir}`
        : "agent-worker-grandchild";
      const grandchild = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { argv0, stdio: "ignore" },
      );
      grandchild.unref();
      mark("grandchild.json", { pid: grandchild.pid ?? null, argv0 });
      await new Promise(() => {});
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
      const delay = Number(process.env.AGENT_WORKER_FAKE_DELAY_MS ?? 300);
      await new Promise((resolve) =>
        setTimeout(resolve, Number.isFinite(delay) ? delay : 300),
      );
    }

    const catalogAnswer = catalogAnswerFor(task);
    if (catalogAnswer) {
      if (mode === "catalog-no-events") {
        return {
          status: "completed",
          output: catalogAnswer,
          text: JSON.stringify(catalogAnswer),
          steps: 3,
          durationMs: 25,
          usage,
          workspace: "",
        };
      }
      emitStandardEvents(options, task);
      if (mode === "catalog-ambiguous") {
        return {
          status: "completed",
          output: null,
          text: "The cheapest Home product is the Pebble Plant Pot.",
          steps: 3,
          durationMs: 25,
          usage,
          workspace: "",
        };
      }
      if (mode === "catalog-invalid") {
        return {
          status: "completed",
          output: { names: ["Atlas Travel Backpack"], count: 1 },
          text: '{"names":["Atlas Travel Backpack"],"count":1}',
          steps: 3,
          durationMs: 25,
          usage,
          workspace: "",
        };
      }
      return {
        status: "completed",
        output: catalogAnswer,
        text: JSON.stringify(catalogAnswer),
        steps: 3,
        durationMs: 25,
        usage,
        workspace: "",
      };
    }

    if (mode === "blocked") {
      // Blocks the worker event loop (and therefore its heartbeats and cancel
      // handling) without burning CPU; only an OS signal can stop it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
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

    // E2E-only: a task carrying this marker waits for the supervisor cancel so
    // the dashboard can render the active/cancelling/cancelled states
    // deterministically instead of racing a fast mocked run.
    if (typeof task === "string" && task.includes("[[cancel]]")) {
      options.onEvent?.({ type: "agent_start" });
      options.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "javascript",
        args: {},
      });
      return await new Promise((resolve) => {
        const finish = () =>
          setTimeout(
            () =>
              resolve({
                status: "cancelled",
                text: "cancelled by the user",
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

    const form = formTaskFor(task);
    if (form) {
      // Form tasks need live UI proof, which a mock cannot provide. Do not
      // emit browser tool events here, so the dashboard reports UI unverified
      // instead of claiming a mocked full pass.
      const answer = formTaskAnswer(form);
      return {
        status: "completed",
        output: answer,
        text: JSON.stringify(answer),
        steps: 3,
        durationMs: 25,
        usage,
        workspace: "",
      };
    }

    emitStandardEvents(options, task);
    return {
      status: "completed",
      output: headingAnswer.output,
      text: headingAnswer.text,
      steps: 3,
      durationMs: 25,
      usage,
      workspace: "",
    };
  },
  async execute(code) {
    if (typeof code === "string" && code.includes("page.info")) {
      const match =
        typeof currentTask === "string"
          ? currentTask.match(/https?:\/\/[^\s"'`]+\/shop\b/)
          : null;
      return {
        text: JSON.stringify({
          url:
            match?.[0]?.replace(/[),.;]+$/, "") ?? "http://127.0.0.1:3000/",
          title: "Shop",
        }),
      };
    }
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
    if (mode === "close-hang") {
      if (typeof profileDir === "string") {
        const grandchild = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          {
            argv0: `--user-data-dir=${profileDir}`,
            stdio: "ignore",
          },
        );
        grandchild.unref();
        mark("close-grandchild.json", { pid: grandchild.pid ?? null });
      }
      await new Promise(() => {});
    }
  },
};

export const BrowserUse = {
  create: async (options) => {
    const createDelay = Number(process.env.AGENT_WORKER_FAKE_CREATE_DELAY_MS ?? 0);
    if (Number.isFinite(createDelay) && createDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, createDelay));
    }
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

const runInner = agent.run.bind(agent);
agent.run = async (task, options = {}) => {
  currentTask = task;
  sawBrowserTool = false;
  return attachRecording(await runInner(task, options));
};
