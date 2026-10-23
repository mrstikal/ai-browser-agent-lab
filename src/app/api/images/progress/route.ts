import { loadImageProgress } from "@/server/image-progress";
import { createStorage } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const snapshot = await loadImageProgress(createStorage());
    return Response.json(snapshot, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: { code: "state-unreadable", message: "Progress is unreadable." } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
