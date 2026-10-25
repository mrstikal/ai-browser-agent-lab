import { z } from "zod";
import {
  AGENT_STREAM_VERSION,
  AGENT_TRACE_VERSION,
  type AgentStreamSnapshot,
  type AgentTracePayload,
} from "@/lib/agent-trace";
import {
  pickAgentDashboardView,
  selectTraceRun,
} from "@/lib/agent-dashboard-view";
import { loadAgentStatus } from "@/server/agent-manager";
import { loadAgentTraceView } from "@/server/agent-trace";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_INTERVAL_MS = 1_000;

export interface AgentTraceCursor {
  readonly runId: string;
  readonly seq: number;
}

/**
 * `id: <runId>:<seq>` lets the native EventSource send Last-Event-ID on
 * reconnect; only a cursor for the currently streamed run is honored, so a
 * changed run always restarts from its first persisted event.
 */
export function parseLastEventId(value: string | null): AgentTraceCursor | null {
  if (value === null) return null;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,7})$/i.exec(
      value,
    );
  if (!match?.[1] || !match[2]) return null;
  if (!z.uuid().safeParse(match[1]).success) return null;
  const seq = Number(match[2]);
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { runId: match[1], seq };
}

/**
 * `?run=<uuid>` pins the trace to a persisted run selected from history. An
 * absent value keeps the default active/latest-task behavior; a present but
 * malformed value is rejected instead of silently streaming another run.
 */
export function parseSelectedRunId(value: string | null): string | null {
  if (value === null) return null;
  return z.uuid().safeParse(value).success ? value : null;
}

export async function GET(request: Request): Promise<Response> {
  const rawSelectedRunId = new URL(request.url).searchParams.get("run");
  const selectedRunId = parseSelectedRunId(rawSelectedRunId);
  if (rawSelectedRunId !== null && selectedRunId === null) {
    return Response.json(
      {
        error: {
          code: "invalid-run-id",
          message: "The selected agent run ID must be a UUID.",
        },
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  let storage: ReturnType<typeof createStorage>;
  try {
    storage = createStorage();
  } catch {
    return Response.json(
      {
        error: {
          code: "storage-unavailable",
          message: "Agent storage is unavailable; no stream was opened.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
  const cursor = parseLastEventId(request.headers.get("last-event-id"));
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    try {
      controller.close();
    } catch {
      // The client may already have disconnected.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let busy = false;
      let lastSnapshotJson = "";
      let lastTraceRunId: string | null | undefined = cursor?.runId;
      let lastSentSeq = cursor?.seq ?? 0;
      let traceInitialized = cursor !== null;
      let traceErrorRunId: string | null = null;

      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        }
      };

      const tick = async () => {
        if (closed || busy) return;
        busy = true;
        let sent = false;
        try {
          let status;
          try {
            status = await loadAgentStatus({ storage });
          } catch {
            enqueue('event: stream-error\ndata: {"code":"state-unreadable"}\n\n');
            return;
          }

          const view = pickAgentDashboardView(status);
          const stable = JSON.stringify({
            view,
            corruptRuns: status.corruptRuns,
          });
          if (stable !== lastSnapshotJson) {
            lastSnapshotJson = stable;
            const snapshot: AgentStreamSnapshot = {
              version: AGENT_STREAM_VERSION,
              generatedAt: new Date().toISOString(),
              view,
              corruptRuns: status.corruptRuns,
            };
            enqueue(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
            sent = true;
          }

          const traceRun = selectTraceRun(view, selectedRunId);
          if (traceRun === null) {
            if (lastTraceRunId !== null || !traceInitialized) {
              const payload: AgentTracePayload = {
                version: AGENT_TRACE_VERSION,
                runId: null,
                events: [],
                truncated: false,
                reset: true,
              };
              enqueue(`event: trace\ndata: ${JSON.stringify(payload)}\n\n`);
              sent = true;
            }
            lastTraceRunId = null;
            lastSentSeq = 0;
            traceInitialized = true;
          } else {
            let trace;
            let recovered = false;
            try {
              trace = await loadAgentTraceView(storage, traceRun.runId);
              recovered = traceErrorRunId === traceRun.runId;
              traceErrorRunId = null;
            } catch {
              trace = null;
              if (traceErrorRunId !== traceRun.runId) {
                traceErrorRunId = traceRun.runId;
                enqueue(
                  'event: stream-error\ndata: {"code":"trace-unreadable"}\n\n',
                );
              }
            }
            if (trace !== null) {
              const reset =
                !traceInitialized || traceRun.runId !== lastTraceRunId;
              const after = reset ? 0 : lastSentSeq;
              const events = trace.events.filter((event) => event.seq > after);
              // A successful read after an error must clear the client banner
              // even when no new event was appended in the meantime.
              if (reset || events.length > 0 || recovered) {
                const lastSeq = events.at(-1)?.seq ?? trace.events.at(-1)?.seq ?? 0;
                const payload: AgentTracePayload = {
                  version: AGENT_TRACE_VERSION,
                  runId: trace.runId,
                  events,
                  truncated: trace.truncated,
                  reset,
                };
                const id =
                  lastSeq > 0 ? `id: ${trace.runId}:${lastSeq}\n` : "";
                enqueue(
                  `event: trace\n${id}data: ${JSON.stringify(payload)}\n\n`,
                );
                sent = true;
                lastSentSeq = lastSeq;
              }
              lastTraceRunId = trace.runId;
              traceInitialized = true;
            }
          }

          if (!sent) enqueue(`: heartbeat ${Date.now()}\n\n`);
        } finally {
          busy = false;
        }
      };

      request.signal.addEventListener("abort", () => close(controller), {
        once: true,
      });
      if (request.signal.aborted) {
        close(controller);
        return;
      }

      await tick();
      if (!closed) {
        timer = setInterval(() => {
          void tick();
        }, POLL_INTERVAL_MS);
      }
    },
    cancel() {
      closed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
