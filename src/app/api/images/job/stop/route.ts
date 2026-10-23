import { z } from "zod";
import { requestImageJobStop } from "@/server/image-job";
import { ImageStateCorruptionError } from "@/server/image-state";
import { readGuardedMutation } from "@/server/mutation-guard";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const stopSchema = z.strictObject({
  jobId: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  ),
});

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: stopSchema });
  if (!guarded.ok) return guarded.response;

  let result;
  try {
    result = await requestImageJobStop({
      storage: createStorage(),
      jobId: guarded.data.jobId,
    });
  } catch (error) {
    if (error instanceof ImageStateCorruptionError) {
      return Response.json(
        {
          error: {
            code: "state-corrupt",
            message:
              "Saved image-job state is unreadable. Inspect data/image-job.json before stopping.",
          },
        },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        error: {
          code: "state-error",
          message: "The stop request could not be persisted.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    {
      applied: result.applied,
      reason: result.applied ? null : result.reason,
      jobId: result.job?.jobId ?? null,
      status: result.job?.status ?? null,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
