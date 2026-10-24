import { z } from "zod";
import { readGuardedMutation } from "@/server/mutation-guard";
import { createStorage } from "@/server/storage";
import { resetSubmissions } from "@/server/submissions-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const resetSchema = z.strictObject({ confirm: z.literal(true) });

export async function POST(request: Request): Promise<Response> {
  const guarded = await readGuardedMutation(request, { schema: resetSchema });
  if (!guarded.ok) return guarded.response;

  try {
    const removed = await resetSubmissions(createStorage());
    return Response.json(
      { ok: true, removed },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error(
      `[ai-browser-agent-lab] submissions reset failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return Response.json(
      {
        error: {
          code: "reset-failed",
          message: "The submissions could not be reset.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
