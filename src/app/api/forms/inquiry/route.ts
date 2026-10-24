import { inquirySubmissionSchema } from "@/lib/schemas";
import {
  InquirySubmissionError,
  saveInquirySubmission,
} from "@/server/inquiry-form";
import { readGuardedMutation } from "@/server/mutation-guard";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const guarded = await readGuardedMutation(request, {
    schema: inquirySubmissionSchema,
  });
  if (!guarded.ok) return guarded.response;

  try {
    const saved = await saveInquirySubmission(createStorage(), guarded.data);
    return Response.json(
      { ok: true, requestId: saved.id, createdAt: saved.createdAt },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof InquirySubmissionError && error.code === "conflict") {
      return Response.json(
        {
          error: {
            code: "idempotency-conflict",
            message: "This request ID was already used with different values.",
          },
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    console.error(
      `[ai-browser-agent-lab] inquiry submission failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return Response.json(
      {
        error: {
          code: "submission-failed",
          message: "The product inquiry could not be stored.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
