import { loadImageProgress } from "@/server/image-progress";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_INTERVAL_MS = 1000;

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastJson = "";

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
        try {
          const snapshot = await loadImageProgress(createStorage());
          const stableJson = JSON.stringify(snapshot, (key, value) =>
            key === "generatedAt" ? undefined : value,
          );
          if (stableJson !== lastJson) {
            lastJson = stableJson;
            enqueue(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          } else {
            enqueue(`: heartbeat ${Date.now()}\n\n`);
          }
        } catch {
          enqueue('event: error\ndata: {"code":"state-unreadable"}\n\n');
        } finally {
          busy = false;
        }
      };

      request.signal.addEventListener(
        "abort",
        () => close(controller),
        { once: true },
      );
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
