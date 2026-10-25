import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as streamRoute from "@/app/api/agent/stream/route";
import {
  AGENT_TRACE_VERSION,
  type AgentTracePayload,
} from "@/lib/agent-trace";
import type { AgentWorkerEventMessage } from "@/lib/agent-ipc";
import {
  agentEventFileSegments,
  appendAgentEvent,
  saveAgentRun,
  type AgentRunRecord,
} from "@/server/agent-runs";
import {
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "@/server/credentials";
import { createStorage } from "@/server/storage";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_RUN_ID = "33333333-3333-4333-8333-333333333333";
const VERIFICATION_ID = "22222222-2222-4222-8222-222222222222";
const TEST_KEY = "stream-test-secret-key-77";
const ORIGIN = "http://127.0.0.1:3000";

let dataDir: string;
const previousEnv: Record<string, string | undefined> = {};

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 2,
    runId: RUN_ID,
    kind: "task",
    presetId: null,
    formBaseline: null,
    task: "Read the main heading.",
    modelId: "openrouter/openai/gpt-5.6-luna",
    origin: ORIGIN,
    limits: { maxSteps: 30, timeoutMs: 180_000, maxCostUsd: 1 },
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-10-24T10:00:00.000Z",
    endedAt: "2026-10-24T10:00:05.000Z",
    updatedAt: "2026-10-24T10:00:05.000Z",
    steps: 3,
    durationMs: 5_000,
    outputText: '{"heading":"Shop"}',
    error: null,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostUsd: 0.01,
    },
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "not_evaluated", reason: null },
    uiEvidence: "unverified",
    worker: null,
    eventCount: 0,
    lastSeq: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
    ...overrides,
  };
}

function makeEvent(
  seq: number,
  kind: AgentWorkerEventMessage["kind"],
  overrides: Partial<AgentWorkerEventMessage> = {},
): AgentWorkerEventMessage {
  return {
    type: "event",
    runId: RUN_ID,
    seq,
    at: `2026-10-24T10:00:0${seq}.000Z`,
    kind,
    ...overrides,
  };
}

async function seedTrace(
  kinds: AgentWorkerEventMessage["kind"][] = [
    "agent_start",
    "tool_start",
    "tool_end",
  ],
): Promise<void> {
  const storage = createStorage();
  await saveAgentRun(storage, makeRun());
  for (const [index, kind] of kinds.entries()) {
    await appendAgentEvent(
      storage,
      makeEvent(index + 1, kind, {
        ...(kind === "tool_start" || kind === "tool_end"
          ? { toolName: "javascript" }
          : {}),
      }),
    );
  }
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  maxReads = 8,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < maxReads; index += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) break;
  }
  return text;
}

function parseTrace(text: string): AgentTracePayload {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { version?: unknown }).version === AGENT_TRACE_VERSION &&
      Array.isArray((payload as { events?: unknown }).events)
    ) {
      return payload as AgentTracePayload;
    }
  }
  throw new Error(`No trace payload found in the SSE chunk:\n${text}`);
}

async function openStream(
  headers: Record<string, string> = {},
): Promise<{
  controller: AbortController;
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const controller = new AbortController();
  const response = await streamRoute.GET(
    new Request(`${ORIGIN}/api/agent/stream`, {
      signal: controller.signal,
      headers,
    }),
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE body.");
  return { controller, response, reader };
}

async function closeStream(
  controller: AbortController,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  controller.abort();
  await reader.cancel().catch(() => undefined);
}

beforeEach(async () => {
  previousEnv.DATA_DIR = process.env.DATA_DIR;
  previousEnv.APP_ORIGIN = process.env.APP_ORIGIN;
  dataDir = await mkdtemp(join(tmpdir(), "agent-stream-"));
  process.env.DATA_DIR = dataDir;
  process.env.APP_ORIGIN = ORIGIN;
  resetCredentialHolderForTests();
});

afterEach(async () => {
  resetCredentialHolderForTests();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe("agent SSE stream route", () => {
  it("streams a status snapshot and the persisted task trace", async () => {
    await seedTrace();
    const { controller, response, reader } = await openStream();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");

    const text = await readStreamUntil(reader, (value) =>
      value.includes("event: trace"),
    );
    expect(text).toContain("event: snapshot");
    expect(text).toContain(`"activeRunId":null`);
    expect(text).toContain(`id: ${RUN_ID}:3\n`);
    const trace = parseTrace(text);
    expect(trace).toMatchObject({
      runId: RUN_ID,
      reset: true,
      truncated: false,
    });
    expect(trace.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    await closeStream(controller, reader);
  }, 10_000);

  it("resumes after Last-Event-ID without resending earlier events", async () => {
    await seedTrace();
    const { controller, reader } = await openStream({
      "last-event-id": `${RUN_ID}:2`,
    });
    const text = await readStreamUntil(reader, (value) =>
      value.includes("event: trace"),
    );
    const trace = parseTrace(text);
    expect(trace.reset).toBe(false);
    expect(trace.events.map((event) => event.seq)).toEqual([3]);
    expect(text).toContain(`id: ${RUN_ID}:3\n`);
    await closeStream(controller, reader);
  }, 10_000);

  it("delivers events appended after the initial trace", async () => {
    await seedTrace(["agent_start", "tool_start"]);
    const { controller, reader } = await openStream();
    await readStreamUntil(reader, (value) => value.includes("event: trace"));
    await appendAgentEvent(
      createStorage(),
      makeEvent(3, "tool_end", { toolName: "javascript" }),
    );
    const text = await readStreamUntil(reader, (value) =>
      value.includes('"seq":3'),
    );
    expect(text).toContain(`id: ${RUN_ID}:3\n`);
    expect(parseTrace(text).events.map((event) => event.seq)).toEqual([3]);
    await closeStream(controller, reader);
  }, 10_000);

  it("restarts from the first event when the cursor belongs to another run", async () => {
    await seedTrace();
    const storage = createStorage();
    await saveAgentRun(
      storage,
      makeRun({
        runId: SECOND_RUN_ID,
        startedAt: "2026-10-24T11:00:00.000Z",
        updatedAt: "2026-10-24T11:00:05.000Z",
        endedAt: "2026-10-24T11:00:05.000Z",
      }),
    );
    await appendAgentEvent(
      storage,
      makeEvent(1, "agent_start", { runId: SECOND_RUN_ID }),
    );
    await appendAgentEvent(
      storage,
      makeEvent(2, "tool_start", {
        runId: SECOND_RUN_ID,
        toolName: "javascript",
      }),
    );

    const { controller, reader } = await openStream({
      "last-event-id": `${RUN_ID}:2`,
    });
    const text = await readStreamUntil(reader, (value) =>
      value.includes("event: trace"),
    );
    const trace = parseTrace(text);
    expect(trace).toMatchObject({ runId: SECOND_RUN_ID, reset: true });
    expect(trace.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(text).toContain(`id: ${SECOND_RUN_ID}:2\n`);
    await closeStream(controller, reader);
  }, 10_000);

  it("emits a heartbeat while nothing changes", async () => {
    await seedTrace();
    const { controller, reader } = await openStream();
    await readStreamUntil(reader, (value) => value.includes("event: trace"));
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain(": heartbeat");
    await closeStream(controller, reader);
  }, 10_000);

  it("closes the stream when the request aborts", async () => {
    await seedTrace();
    const { controller, reader } = await openStream();
    await readStreamUntil(reader, (value) => value.includes("event: trace"));
    controller.abort();
    let done = false;
    for (let index = 0; index < 4 && !done; index += 1) {
      done = (await reader.read()).done;
    }
    expect(done).toBe(true);
  }, 10_000);

  it("reports an unreadable trace without closing the stream", async () => {
    await seedTrace();
    const storage = createStorage();
    await storage.writeFile(
      agentEventFileSegments(RUN_ID),
      "{not-json\n{}\n",
    );
    const { controller, reader } = await openStream();
    const text = await readStreamUntil(reader, (value) =>
      value.includes("stream-error"),
    );
    expect(text).toContain('"code":"trace-unreadable"');
    await closeStream(controller, reader);
  }, 10_000);

  it("clears a trace error after a successful read with no new events", async () => {
    await seedTrace();
    const storage = createStorage();
    const valid = [
      makeEvent(1, "agent_start"),
      makeEvent(2, "tool_start", { toolName: "javascript" }),
      makeEvent(3, "tool_end", { toolName: "javascript" }),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
      .concat("\n");
    const { controller, reader } = await openStream();
    await readStreamUntil(reader, (value) => value.includes("event: trace"));

    await storage.writeFile(
      agentEventFileSegments(RUN_ID),
      "{not-json\n{}\n",
    );
    const errorText = await readStreamUntil(reader, (value) =>
      value.includes("trace-unreadable"),
    );
    expect(errorText).toContain("trace-unreadable");

    await storage.writeFile(agentEventFileSegments(RUN_ID), valid);
    const recoveryText = await readStreamUntil(reader, (value) =>
      value.includes("event: trace"),
    );
    expect(parseTrace(recoveryText)).toMatchObject({
      runId: RUN_ID,
      reset: false,
      events: [],
    });
    await closeStream(controller, reader);
  }, 15_000);

  it("returns a JSON error when storage cannot be configured", async () => {
    process.env.DATA_DIR = "";
    const response = await streamRoute.GET(
      new Request(`${ORIGIN}/api/agent/stream`),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "storage-unavailable" },
    });
    process.env.DATA_DIR = dataDir;
  });

  it("replays the same ordered trace on a fresh connection", async () => {
    await seedTrace();
    const readTrace = async (): Promise<number[]> => {
      const { controller, reader } = await openStream();
      const text = await readStreamUntil(reader, (value) =>
        value.includes("event: trace"),
      );
      await closeStream(controller, reader);
      return parseTrace(text).events.map((event) => event.seq);
    };
    expect(await readTrace()).toEqual([1, 2, 3]);
    expect(await readTrace()).toEqual([1, 2, 3]);
  }, 15_000);

  it("never exposes the key, request headers, or cookies", async () => {
    await seedTrace();
    const storage = createStorage();
    await setOpenRouterKey(TEST_KEY, {
      remember: false,
      env: process.env,
      storage,
    });

    const { controller, reader } = await openStream();
    const text = await readStreamUntil(reader, (value) =>
      value.includes("event: trace"),
    );
    expect(text).toContain('"keyAvailable":true');
    expect(text).not.toContain(TEST_KEY);
    expect(text.toLowerCase()).not.toContain("authorization");
    expect(text.toLowerCase()).not.toContain("cookie");
    await closeStream(controller, reader);
  }, 10_000);

  it("sends a null trace when only a verification run exists", async () => {
    const storage = createStorage();
    await saveAgentRun(
      storage,
      makeRun({
        runId: VERIFICATION_ID,
        kind: "verification",
        task: "Read the Shop heading.",
      }),
    );
    const { controller, reader } = await openStream();
    const text = await readStreamUntil(reader, (value) =>
      value.includes("event: trace"),
    );
    const trace = parseTrace(text);
    expect(trace).toMatchObject({ runId: null, events: [], reset: true });
    await closeStream(controller, reader);
  }, 10_000);

  it("parses only well-formed trace cursors", () => {
    expect(streamRoute.parseLastEventId(`${RUN_ID}:7`)).toEqual({
      runId: RUN_ID,
      seq: 7,
    });
    expect(streamRoute.parseLastEventId(null)).toBeNull();
    expect(streamRoute.parseLastEventId("")).toBeNull();
    expect(streamRoute.parseLastEventId(`${RUN_ID}:0`)).toEqual({
      runId: RUN_ID,
      seq: 0,
    });
    expect(streamRoute.parseLastEventId(`${RUN_ID}:-1`)).toBeNull();
    expect(streamRoute.parseLastEventId("not-a-run:4")).toBeNull();
    expect(
      streamRoute.parseLastEventId(
        "11111111-1111-1111-1111-111111111111:4",
      ),
    ).toBeNull();
    expect(streamRoute.parseLastEventId(`${RUN_ID}:12345678`)).toBeNull();
  });
});
