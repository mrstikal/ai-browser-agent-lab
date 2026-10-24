const mode = process.env.AGENT_SMOKE_FAKE_MODE ?? "success";
const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};
let runs = 0;

export const Browser = {
  chromium: (options) => ({ kind: "chromium", ...options }),
};

export const Type = {
  Object: (properties, options) => ({ type: "object", properties, options }),
  String: (options) => ({ type: "string", ...options }),
};

const agent = {
  async run(_task, options) {
    runs += 1;
    if (mode === "blocked") {
      throw new Error("Unsupported model provider");
    }
    if (mode === "blocked-key") {
      throw new Error(`Invalid API key ${process.env.OPENROUTER_API_KEY ?? ""}`);
    }
    if (mode === "fail-then-success" && runs === 1) {
      return {
        status: "error",
        text: "",
        error: "temporary model failure",
        steps: 1,
        durationMs: 1,
        usage,
        workspace: "",
      };
    }
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
    return {
      status: "completed",
      output: { heading: "Shop" },
      text: "{\"heading\":\"Shop\"}",
      steps: 1,
      durationMs: 1,
      ...(mode === "missing-usage" ? {} : { usage }),
      workspace: "",
    };
  },
  async execute() {
    if (mode === "domain-open") return {};
    throw new Error("Navigation blocked by domain policy.");
  },
  async close() {},
};

export const BrowserUse = {
  create: async () => {
    if (mode === "chrome-exit") {
      throw new Error("Chrome exited before exposing CDP.");
    }
    return agent;
  },
};
