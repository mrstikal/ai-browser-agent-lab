import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as traceRoute from "@/app/api/agent/runs/[runId]/trace/route";
import { AGENT_TRACE_VERSION } from "@/lib/agent-trace";
import type { AgentWorkerEventMessage } from "@/lib/agent-ipc";
import {
  AGENT_RUN_LIST_LIMIT,
  agentEventFileSegments,
  appendAgentEvent,
  saveAgentRun,
  type AgentRunRecord,
} from "@/server/agent-runs";
import { createStorage } from "@/server/storage";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "http://127.0.0.1:3000";

let dataDir: string;
const previousEnv: Record<string, string | undefined> = {};

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 2,
    runId: RUN_ID,
    kind: "task",
    presetId: null,
    uiMode: null,
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
    usage: null,
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "not_evaluated", reason: null },
    uiEvidence: "unverified",
    worker: null,
    eventCount: 3,
    lastSeq: 3,
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

async function readTrace(runId = RUN_ID): Promise<Response> {
  return traceRoute.GET(
    new Request(`${ORIGIN}/api/agent/runs/${runId}/trace`),
    { params: Promise.resolve({ runId }) },
  );
}

beforeEach(async () => {
  previousEnv.DATA_DIR = process.env.DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "agent-trace-route-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe("agent history trace route", () => {
  it("returns the bounded persisted trace for a saved run", async () => {
    const storage = createStorage();
    await saveAgentRun(storage, makeRun());
    for (const [index, kind] of [
      "agent_start",
      "tool_start",
      "tool_end",
    ].entries()) {
      await appendAgentEvent(
        storage,
        makeEvent(index + 1, kind as AgentWorkerEventMessage["kind"], {
          ...(kind === "tool_start" || kind === "tool_end"
            ? { toolName: "javascript" }
            : {}),
        }),
      );
    }

    const response = await readTrace();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const payload = (await response.json()) as {
      version: number;
      runId: string;
      events: AgentWorkerEventMessage[];
      truncated: boolean;
      reset: boolean;
    };
    expect(payload).toMatchObject({
      version: AGENT_TRACE_VERSION,
      runId: RUN_ID,
      reset: true,
      truncated: false,
    });
    expect(payload.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("returns 404 for a UUID that is not in saved history", async () => {
    const response = await readTrace("22222222-2222-4222-8222-222222222222");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "run-not-found" },
    });
  });

  it("does not serve a run outside the bounded history window", async () => {
    const storage = createStorage();
    const baseTime = Date.parse("2026-10-24T00:00:00.000Z");
    const oldestRunId = "00000000-0000-4000-8000-000000000000";
    for (let index = 0; index <= AGENT_RUN_LIST_LIMIT; index += 1) {
      const runId =
        index === 0
          ? oldestRunId
          : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const startedAt = new Date(baseTime + index * 1_000).toISOString();
      await saveAgentRun(
        storage,
        makeRun({
          runId,
          startedAt,
          endedAt: startedAt,
          updatedAt: startedAt,
        }),
      );
    }

    expect((await readTrace(oldestRunId)).status).toBe(404);
    expect(
      (
        await readTrace(
          `00000000-0000-4000-8000-${String(AGENT_RUN_LIST_LIMIT).padStart(12, "0")}`,
        )
      ).status,
    ).toBe(200);
  });

  it("rejects a non-UUID run ID", async () => {
    const response = await readTrace("not-a-run");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid-run-id" },
    });
  });

  it("reports an unreadable event log without leaking its contents", async () => {
    const storage = createStorage();
    await saveAgentRun(storage, makeRun());
    await storage.writeFile(agentEventFileSegments(RUN_ID), "{not-json\n{}\n");

    const response = await readTrace();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "trace-unreadable" },
    });
  });

  it("returns a JSON error when storage cannot be configured", async () => {
    process.env.DATA_DIR = "";
    const response = await readTrace();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "storage-unavailable" },
    });
    process.env.DATA_DIR = dataDir;
  });
});
