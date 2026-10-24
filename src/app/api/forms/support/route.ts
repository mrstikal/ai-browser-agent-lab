import { supportSubmissionSchema } from "@/lib/schemas";
import { readGuardedMutation } from "@/server/mutation-guard";
import { saveSupportSubmission } from "@/server/support-form";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const guarded = await readGuardedMutation(request, {
    schema: supportSubmissionSchema,
  });
  if (!guarded.ok) return guarded.response;

  try {
    const saved = await saveSupportSubmission(createStorage(), guarded.data);
    return Response.json(
      { ok: true, requestId: saved.id, createdAt: saved.createdAt },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "submission-failed",
          message: "The support request could not be stored.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
